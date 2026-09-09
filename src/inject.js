/*
 * Absolute Cinema — page-context bridge (MAIN world).
 *
 * YouTube's player object hangs off #movie_player as expando properties, which
 * are invisible from a content script's isolated world. This file runs in the
 * page so it can call the player API directly, and talks to content.js over
 * window.postMessage.
 */
(() => {
  'use strict';

  // Guard against a double injection (SPA re-entry, or a browser that also
  // honours a MAIN-world content script).
  if (window.__absoluteCinemaBridge) return;
  window.__absoluteCinemaBridge = true;

  const TO_PAGE = 'absolute-cinema:to-page';
  const TO_CONTENT = 'absolute-cinema:to-content';

  // High -> low. YouTube's quality tokens paired with their nominal height.
  const LADDER = [
    ['highres', 4320],
    ['hd2880', 2880],
    ['hd2160', 2160],
    ['hd1440', 1440],
    ['hd1080', 1080],
    ['hd720', 720],
    ['large', 480],
    ['medium', 360],
    ['small', 240],
    ['tiny', 144],
  ];
  const HEIGHT = new Map(LADDER);
  const RANK = new Map(LADDER.map(([q], i) => [q, i]));

  let settings = null;
  let appliedFor = '';
  let retryTimers = [];

  const send = (type, payload) =>
    window.postMessage({ tag: TO_CONTENT, type, payload }, '*');

  function getPlayer() {
    const el =
      document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player');
    return el && typeof el.getAvailableQualityLevels === 'function' ? el : null;
  }

  // "1080p60" -> 60, "2160p" -> 30, "1440p50 HDR" -> 50
  function fpsFromLabel(label) {
    const m = /^(\d+)p(\d+)?/.exec(String(label || '').trim());
    if (!m) return null;
    return m[2] ? parseInt(m[2], 10) : 30;
  }

  /** Normalised, playable-first quality list, ordered best -> worst. */
  function qualityList(p) {
    let data = [];
    try {
      data = p.getAvailableQualityData() || [];
    } catch {}

    let out = data
      .filter((d) => d && RANK.has(d.quality))
      .map((d) => ({
        q: d.quality,
        height: HEIGHT.get(d.quality),
        label: d.qualityLabel || '',
        fps: fpsFromLabel(d.qualityLabel),
        playable: d.isPlayable !== false,
      }));

    if (!out.length) {
      // Older/embedded players expose only the token list, with no fps info.
      let levels = [];
      try {
        levels = p.getAvailableQualityLevels() || [];
      } catch {}
      out = levels
        .filter((q) => RANK.has(q))
        .map((q) => ({
          q,
          height: HEIGHT.get(q),
          label: '',
          fps: null,
          playable: true,
        }));
    }

    // Collapse duplicate tokens (HDR/SDR pairs share a quality token); keep the
    // first, which is the one the player would pick anyway.
    const seen = new Set();
    out = out.filter((x) => (seen.has(x.q) ? false : seen.add(x.q)));
    out.sort((a, b) => RANK.get(a.q) - RANK.get(b.q));
    return out;
  }

  /**
   * Choose a quality token.
   *  - quality acts as a ceiling: exact match if present, else the next best
   *    thing available below it.
   *  - in "stream" fps mode the ceiling is applied first, then we keep only
   *    streams at or under the fps target; if none qualify we fall back to the
   *    lowest fps on offer (24 is never a real YouTube stream rate).
   */
  function choose(list, s) {
    let pool = list.filter((x) => x.playable);
    if (!pool.length) pool = list.slice();
    if (!pool.length) return null;

    if (s.quality && s.quality !== 'auto') {
      const cap = HEIGHT.get(s.quality);
      if (cap != null) {
        const under = pool.filter((x) => x.height <= cap);
        if (under.length) pool = under;
      }
    }

    if (s.fpsMode === 'stream' && s.fpsCap) {
      const known = pool.filter((x) => x.fps != null);
      if (known.length) {
        const ok = known.filter((x) => x.fps <= s.fpsCap);
        if (ok.length) {
          pool = ok;
        } else {
          const min = Math.min(...known.map((x) => x.fps));
          pool = known.filter((x) => x.fps === min);
        }
      }
    }

    return pool[0] || null;
  }

  function currentFps(p, list) {
    let cur = null;
    try {
      cur = p.getPlaybackQuality();
    } catch {}
    const hit = list.find((x) => x.q === cur);
    return { quality: cur, label: hit ? hit.label : '', fps: hit ? hit.fps : null };
  }

  function videoKey(p) {
    try {
      const d = p.getVideoData ? p.getVideoData() : null;
      if (d && d.video_id) return d.video_id;
    } catch {}
    return location.href;
  }

  function apply() {
    const p = getPlayer();
    if (!p || !settings) return false;

    const list = qualityList(p);
    if (!list.length) return false;

    const pick = choose(list, settings);
    if (!pick) return false;

    const key = videoKey(p);
    let active = null;
    try {
      active = p.getPlaybackQuality();
    } catch {}

    if (!(appliedFor === key && active === pick.q)) {
      try {
        p.setPlaybackQualityRange(pick.q, pick.q);
      } catch {}
      try {
        p.setPlaybackQuality(pick.q);
      } catch {}
      appliedFor = key;
    }

    const cur = currentFps(p, list);
    send('state', {
      videoId: key,
      picked: pick.q,
      pickedLabel: pick.label,
      pickedFps: pick.fps,
      current: cur.quality,
      currentLabel: cur.label,
      currentFps: cur.fps != null ? cur.fps : pick.fps,
      available: list.map((x) => ({ q: x.q, label: x.label, fps: x.fps })),
      adShowing: p.classList ? p.classList.contains('ad-showing') : false,
    });
    return true;
  }

  /** Players are not ready the instant navigation fires; retry a few times. */
  function scheduleApply() {
    retryTimers.forEach(clearTimeout);
    retryTimers = [0, 250, 700, 1500, 3000].map((ms) =>
      setTimeout(apply, ms)
    );
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.tag !== TO_PAGE) return;
    if (d.type === 'settings') {
      settings = d.payload;
      appliedFor = ''; // settings changed: re-pin even on the current video
      scheduleApply();
    } else if (d.type === 'poke') {
      scheduleApply();
    }
  });

  for (const ev of [
    'yt-navigate-finished',
    'yt-player-updated',
    'yt-page-data-updated',
  ]) {
    document.addEventListener(ev, scheduleApply, true);
  }

  // Catches quality data arriving after the player element exists, and the
  // first load where no yt-* event fires.
  document.addEventListener('loadedmetadata', scheduleApply, true);
  document.addEventListener('canplay', scheduleApply, true);

  scheduleApply();
  send('ready', {});
})();
