/*
 * Absolute Cinema — content script (isolated world).
 *
 * Two jobs:
 *   1. Ferry settings to the page-context bridge, which pins video quality.
 *   2. Run the "cinematic" frame-rate engine: the source video keeps decoding
 *      at 60fps but is made invisible, and a canvas laid over it is repainted
 *      only on 24/30fps media-time boundaries.
 *
 * The "stream" frame-rate mode needs no help here — it is purely a matter of
 * which quality token the bridge asks for.
 */
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime) return;

  const TO_PAGE = 'absolute-cinema:to-page';
  const TO_CONTENT = 'absolute-cinema:to-content';

  const VIDEO_SEL = 'video.html5-main-video';
  const PLAYER_SEL = '.html5-video-player';

  const DEFAULTS = {
    enabled: true,
    quality: 'hd2160',
    fpsCap: 0, // 0 = off
    fpsMode: 'cinematic', // 'cinematic' | 'stream'
    badge: true,
    diag: false,
  };

  const COMMON_FPS = [24, 25, 30, 48, 50, 60, 90, 120];
  const COMMON_HZ = [30, 50, 60, 75, 90, 100, 120, 144, 165, 240];

  let settings = { ...DEFAULTS };
  let pageState = null;

  // ---------------------------------------------------------------- bridge

  function injectPageScript() {
    try {
      const s = document.createElement('script');
      s.src = api.runtime.getURL('src/inject.js');
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
      s.addEventListener('load', () => s.remove());
    } catch {}
  }

  const postToPage = (type, payload) =>
    window.postMessage({ tag: TO_PAGE, type, payload }, '*');

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.tag !== TO_CONTENT) return;
    if (d.type === 'ready') {
      postToPage('settings', settings);
    } else if (d.type === 'state') {
      pageState = d.payload;
      evaluate();
    }
  });

  // ------------------------------------------------------------- measurement

  const snapTo = (table, raw) =>
    table.reduce((best, v) => (Math.abs(v - raw) < Math.abs(best - raw) ? v : best));

  /* Display refresh rate, measured once. It is the ceiling on how evenly any
     cadence can be presented, so the diagnostics need it to be honest about
     what is our fault and what is the panel's. */
  let refreshHz = 0;
  function measureRefresh() {
    if (refreshHz) return;
    refreshHz = -1; // in flight
    let frames = 0;
    let t0 = 0;
    const step = (now) => {
      if (!t0) {
        t0 = now;
        requestAnimationFrame(step);
        return;
      }
      frames++;
      const dt = now - t0;
      if (dt >= 500 && frames >= 20) {
        refreshHz = snapTo(COMMON_HZ, (frames * 1000) / dt);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Count real presented frames for ~700ms to infer the source frame rate. */
  function probeSourceFps(video) {
    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback !== 'function' || video.paused) {
        resolve(null);
        return;
      }
      let frames = 0;
      let t0 = 0;
      let handle = 0;
      const step = (now) => {
        if (!t0) {
          t0 = now;
          handle = video.requestVideoFrameCallback(step);
          return;
        }
        frames++;
        const dt = now - t0;
        if (dt >= 700 && frames >= 8) {
          resolve(snapTo(COMMON_FPS, (frames * 1000) / dt));
          return;
        }
        handle = video.requestVideoFrameCallback(step);
      };
      handle = video.requestVideoFrameCallback(step);
      setTimeout(() => {
        try {
          video.cancelVideoFrameCallback(handle);
        } catch {}
        resolve(null);
      }, 3000);
    });
  }

  // ------------------------------------------------------- cinematic engine

  class Cinema {
    constructor() {
      this.video = null;
      this.player = null;
      this.canvas = null;
      this.ctx = null;
      this.target = 0;
      this.running = false;
      this.lastIndex = -1;
      this.raf = 0;
      this.ro = null;
      this.mo = null;
      this.onFullscreen = () => this.syncLayout();
      this.resetStats();
    }

    resetStats() {
      this.paints = []; // timestamps of recent repaints
      this.drawTotal = 0;
      this.drawCount = 0;
      this.drawPeak = 0;
    }

    start(video, player, target) {
      if (
        this.running &&
        this.video === video &&
        this.player === player &&
        this.target === target
      ) {
        this.syncLayout();
        return;
      }
      this.stop();

      const container = video.parentElement;
      if (!container) return;

      const canvas = document.createElement('canvas');
      canvas.className = 'ac-canvas';
      /* No `desynchronized` here on purpose: low-latency mode lets the canvas
         present out of band with the rest of the page, which is exactly wrong
         for an overlay that has to stay locked to the player. */
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high'; // 8K -> 1080p is a big downscale

      container.appendChild(canvas);
      player.classList.add('ac-cinema-on');

      this.video = video;
      this.player = player;
      this.canvas = canvas;
      this.ctx = ctx;
      this.target = target;
      this.lastIndex = -1;
      this.running = true;
      this.resetStats();

      this.syncLayout();

      this.ro = new ResizeObserver(() => this.syncLayout());
      this.ro.observe(video);
      this.ro.observe(container);
      // YouTube letterboxes by writing inline left/top/width/height on <video>.
      this.mo = new MutationObserver(() => this.syncLayout());
      this.mo.observe(video, { attributes: true, attributeFilter: ['style'] });
      document.addEventListener('fullscreenchange', this.onFullscreen, true);

      measureRefresh();
      this.pump();
    }

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.running = false;
      if (this.ro) this.ro.disconnect();
      if (this.mo) this.mo.disconnect();
      this.ro = this.mo = null;
      document.removeEventListener('fullscreenchange', this.onFullscreen, true);
      if (this.player) this.player.classList.remove('ac-cinema-on');
      if (this.canvas) this.canvas.remove();
      this.canvas = this.ctx = this.video = this.player = null;
      this.target = 0;
      this.lastIndex = -1;
      this.resetStats();
    }

    syncLayout() {
      const v = this.video;
      const c = this.canvas;
      if (!v || !c) return;

      const w = v.offsetWidth;
      const h = v.offsetHeight;
      if (!w || !h) return;

      // The canvas shares <video>'s offset parent, so its box can be copied.
      c.style.left = v.offsetLeft + 'px';
      c.style.top = v.offsetTop + 'px';
      c.style.width = w + 'px';
      c.style.height = h + 'px';

      // Never allocate a backing store larger than the source frame — an 8K
      // stream in a 1080p box should be downscaled once, on the GPU, not
      // rasterised at 8K.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let bw = Math.max(1, Math.round(w * dpr));
      let bh = Math.max(1, Math.round(h * dpr));
      const iw = v.videoWidth || 0;
      if (iw && bw > iw) {
        bh = Math.max(1, Math.round((bh * iw) / bw));
        bw = iw;
      }
      if (c.width !== bw || c.height !== bh) {
        c.width = bw;
        c.height = bh; // resizing clears the canvas and resets context state
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.lastIndex = -1;
        this.paint();
      }
    }

    paint() {
      const { ctx, canvas, video } = this;
      if (!ctx || !video || !video.videoWidth) return;
      const t0 = performance.now();
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        return;
      }
      /* drawImage returns before the GPU is done, so this is a lower bound —
         but a software fallback shows up here as milliseconds instead of
         tenths, which is the distinction we actually care about. */
      const dt = performance.now() - t0;
      this.drawTotal += dt;
      this.drawCount++;
      if (dt > this.drawPeak) this.drawPeak = dt;
      this.paints.push(t0);
      if (this.paints.length > 180) this.paints.splice(0, this.paints.length - 180);
    }

    /*
     * Paced by requestAnimationFrame, deliberately, not by
     * requestVideoFrameCallback.
     *
     * rVFC only fires on vsyncs where a *video* frame was also presented. With
     * a 60fps source on a 120Hz display that is every other vsync, so a 24fps
     * cadence that should land on a clean 5-5-5 grid is forced onto 6-4-6-4
     * instead — a ±8.3ms wobble, 24 times a second, which reads as jitter.
     * rAF fires on every vsync, so the gate can pick the nearest one and the
     * grid comes out as even as the panel allows.
     */
    pump() {
      if (!this.running) return;
      this.raf = requestAnimationFrame(() => {
        if (!this.running) return;
        const v = this.video;
        if (v) {
          const index = Math.floor(v.currentTime * this.target);
          if (index !== this.lastIndex) {
            this.lastIndex = index;
            this.paint();
          }
        }
        this.pump();
      });
    }

    /** Cadence health, for the diagnostics panel. */
    report() {
      const p = this.paints;
      if (p.length < 12) return null;
      const span = p[p.length - 1] - p[0];
      const fps = ((p.length - 1) * 1000) / span;

      /* Phase error against an ideal grid anchored on the first paint. The
         peak-to-peak spread is the number that matters: on a 120Hz panel at
         24fps it should sit near zero, and on 60Hz it cannot beat ~8.3ms
         because 60/24 is not an integer. */
      const step = 1000 / this.target;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < p.length; i++) {
        const err = p[i] - p[0] - i * step;
        if (err < lo) lo = err;
        if (err > hi) hi = err;
      }

      let dropped = null;
      let total = null;
      try {
        const q = this.video.getVideoPlaybackQuality();
        dropped = q.droppedVideoFrames;
        total = q.totalVideoFrames;
      } catch {}

      return {
        fps,
        jitter: hi - lo,
        drawAvg: this.drawCount ? this.drawTotal / this.drawCount : 0,
        drawPeak: this.drawPeak,
        dropped,
        total,
        width: this.canvas ? this.canvas.width : 0,
        height: this.canvas ? this.canvas.height : 0,
      };
    }
  }

  const cinema = new Cinema();

  // -------------------------------------------------------------------- HUD

  const hud = {
    el: null,
    mode: '',
    text: '',
    timer: 0,
    ticker: 0,

    mount(player) {
      if (!this.el || this.el.parentElement !== player) {
        if (this.el) this.el.remove();
        this.el = document.createElement('div');
        player.appendChild(this.el);
        this.text = '';
        this.mode = '';
      }
      return this.el;
    },

    hide() {
      clearInterval(this.ticker);
      this.ticker = 0;
      if (this.el) this.el.remove();
      this.el = null;
      this.text = '';
      this.mode = '';
    },

    /** Short label that fades out after a few seconds. */
    brief(player, text) {
      if (!player || !text) return this.hide();
      if (this.mode === 'diag') this.hide();
      const el = this.mount(player);
      el.className = 'ac-badge ac-badge-show';
      this.mode = 'brief';
      if (text === this.text) return;
      this.text = text;
      el.textContent = '';
      const mark = document.createElement('b');
      mark.textContent = 'AC';
      el.append(mark, document.createTextNode(' ' + text));
      el.classList.add('ac-badge-show');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.el && this.mode === 'brief') this.el.classList.remove('ac-badge-show');
      }, 4000);
    },

    /** Persistent readout, refreshed twice a second. */
    diag(player, rows) {
      if (!player) return this.hide();
      if (this.mode === 'brief') this.hide();
      const el = this.mount(player);
      el.className = 'ac-badge ac-hud ac-badge-show';
      this.mode = 'diag';
      el.textContent = '';
      for (const [k, v, warn] of rows) {
        const key = document.createElement('span');
        key.className = 'ac-k';
        key.textContent = k;
        const val = document.createElement('span');
        val.className = warn ? 'ac-v ac-warn' : 'ac-v';
        val.textContent = v;
        el.append(key, val);
      }
    },
  };

  // ------------------------------------------------------------ diagnostics

  const ms = (n) => (n < 10 ? n.toFixed(2) : n.toFixed(1)) + ' ms';

  function diagRows() {
    const r = cinema.report();
    const rows = [];
    const hz = refreshHz > 0 ? refreshHz : null;

    /* Shown even when idle: if the cap reads 0 here, the setting never
       reached the content script and the popup is the thing to look at. */
    const loaded =
      `${settings.quality} · ` +
      `${settings.fpsCap ? settings.fpsCap + 'fps' : 'no cap'} · ` +
      `${settings.fpsMode}`;

    if (!r) {
      rows.push(['status', cinema.running ? 'warming up…' : decision]);
      rows.push(['settings', loaded, !settings.fpsCap]);
      rows.push(['source', label() || '—']);
      rows.push(['display', hz ? hz + ' Hz' : 'measuring…']);
      return rows;
    }

    // What the panel can do at best: 0 if refresh divides the target evenly.
    const ideal =
      hz && cinema.target
        ? (() => {
            const per = hz / cinema.target;
            return Number.isInteger(per) ? 0 : 1000 / hz / 2;
          })()
        : null;

    rows.push(['cadence', r.fps.toFixed(2) + ' / ' + cinema.target + ' fps',
      Math.abs(r.fps - cinema.target) > 0.5]);
    rows.push([
      'jitter',
      ms(r.jitter) + (ideal !== null ? '  (floor ' + ms(ideal) + ')' : ''),
      ideal !== null && r.jitter > ideal + 3,
    ]);
    rows.push(['draw', ms(r.drawAvg) + '  peak ' + ms(r.drawPeak), r.drawAvg > 3]);
    rows.push(['display', hz ? hz + ' Hz' : 'measuring…']);
    rows.push(['canvas', r.width + ' × ' + r.height]);
    if (r.total != null) {
      const pct = r.total ? (r.dropped / r.total) * 100 : 0;
      rows.push([
        'decoder',
        r.dropped + ' dropped / ' + r.total + '  (' + pct.toFixed(1) + '%)',
        pct > 1,
      ]);
    }
    rows.push(['source', label() || '—']);
    return rows;
  }

  function refreshHud() {
    const player = currentPlayer;
    if (!player) return hud.hide();
    if (settings.enabled && settings.diag) {
      hud.diag(player, diagRows());
      if (!hud.ticker) hud.ticker = setInterval(refreshHud, 500);
      return;
    }
    if (hud.ticker) {
      clearInterval(hud.ticker);
      hud.ticker = 0;
    }
    if (!settings.badge || !settings.enabled) return hud.hide();
    hud.brief(player, briefText());
  }

  // ------------------------------------------------------------ orchestration

  let currentVideo = null;
  let currentPlayer = null;
  let playerObserver = null;
  let probe = { key: null, fps: null, busy: false };
  let briefLabel = '';
  let decision = 'starting up'; // why the engine is or isn't running

  const briefText = () => briefLabel;

  function sourceKey(video) {
    return (pageState && pageState.videoId) || video.currentSrc || 'unknown';
  }

  /** Source frame rate, from YouTube's own quality label if it offers one. */
  function sourceFps(video) {
    if (pageState && pageState.currentFps) return pageState.currentFps;
    const key = sourceKey(video);
    if (probe.key === key && probe.fps) return probe.fps;
    if (!probe.busy) {
      probe.busy = true;
      probeSourceFps(video).then((fps) => {
        probe.busy = false;
        if (fps) {
          probe.key = key;
          probe.fps = fps;
          evaluate();
        }
      });
    }
    return null;
  }

  function label() {
    return (pageState && (pageState.currentLabel || pageState.pickedLabel)) || '';
  }

  function evaluate() {
    const video = currentVideo;
    const player = currentPlayer;
    if (!video || !player) {
      decision = 'no YouTube player on this page';
      cinema.stop();
      return;
    }

    if (!settings.enabled) {
      decision = 'switched off in settings';
      cinema.stop();
      briefLabel = '';
      refreshHud();
      return;
    }

    const wantCinema = settings.fpsMode === 'cinematic' && settings.fpsCap > 0;

    // Ads get a pass: leave YouTube's own video visible and untouched.
    const adShowing =
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting');
    const inPip = document.pictureInPictureElement === video;

    if (!wantCinema || adShowing || inPip) {
      decision = adShowing
        ? 'ad playing — left alone'
        : inPip
        ? 'picture-in-picture — left alone'
        : settings.fpsMode === 'stream'
        ? 'stream mode — no canvas needed'
        : 'frame rate cap is off';
      cinema.stop();
      briefLabel =
        adShowing || inPip
          ? ''
          : settings.fpsMode === 'stream' && settings.fpsCap
          ? `${label() || 'stream'} · ${settings.fpsCap}fps cap`
          : label();
      refreshHud();
      return;
    }

    const src = sourceFps(video);
    if (src == null) {
      decision = 'source frame rate unknown — still probing';
      cinema.stop(); // try again when the probe lands
      return;
    }
    if (src <= settings.fpsCap) {
      decision = `source is ${src}fps, already at or under the cap`;
      cinema.stop();
      briefLabel = `${label() || src + 'fps'} · already ≤ ${settings.fpsCap}fps`;
      refreshHud();
      return;
    }

    cinema.start(video, player, settings.fpsCap);
    decision = 'running';
    briefLabel = `${label() || src + 'fps'} → ${settings.fpsCap}fps`;
    refreshHud();
  }

  const onVideoEvent = () => {
    probe = { key: null, fps: null, busy: false };
    evaluate();
  };

  function scan() {
    const video = document.querySelector(VIDEO_SEL);
    const player = video ? video.closest(PLAYER_SEL) : null;

    if (video !== currentVideo || player !== currentPlayer) {
      if (playerObserver) {
        playerObserver.disconnect();
        playerObserver = null;
      }
      currentVideo = video;
      currentPlayer = player;
      probe = { key: null, fps: null, busy: false };
      cinema.stop();
      hud.hide();

      if (player) {
        // Ad breaks toggle classes on the player root.
        playerObserver = new MutationObserver(() => evaluate());
        playerObserver.observe(player, {
          attributes: true,
          attributeFilter: ['class'],
        });
      }
      if (video) {
        for (const ev of [
          'loadedmetadata',
          'resize',
          'playing',
          'emptied',
          'enterpictureinpicture',
          'leavepictureinpicture',
        ]) {
          video.addEventListener(ev, onVideoEvent);
        }
      }
    }
    evaluate();
  }

  // ---------------------------------------------------------------- settings

  /* get(null) returns only keys that were actually stored, so we can merge
     local then sync and let sync win where both are present. get(DEFAULTS)
     would hand back a full object either way and hide which area is live. */
  async function loadSettings() {
    const merged = { ...DEFAULTS };
    for (const area of ['local', 'sync']) {
      try {
        const got = await api.storage[area].get(null);
        if (!got) continue;
        for (const k of Object.keys(DEFAULTS)) if (k in got) merged[k] = got[k];
      } catch {}
    }
    return merged;
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    let touched = false;
    for (const [k, v] of Object.entries(changes)) {
      if (k in DEFAULTS) {
        settings[k] = v.newValue === undefined ? DEFAULTS[k] : v.newValue;
        touched = true;
      }
    }
    if (!touched) return;
    postToPage('settings', settings);
    cinema.stop();
    hud.hide();
    evaluate();
  });

  // ------------------------------------------------------------------- boot

  injectPageScript();

  loadSettings().then((s) => {
    settings = s;
    postToPage('settings', settings);
    scan();
  });

  for (const ev of ['yt-navigate-finished', 'yt-page-data-updated']) {
    document.addEventListener(
      ev,
      () => {
        pageState = null;
        scan();
      },
      true
    );
  }

  setInterval(scan, 1000);
  document.addEventListener('DOMContentLoaded', scan);
})();
