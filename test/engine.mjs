/*
 * Integration test for the cinematic engine.
 *
 * Loads the real src/content.js into a stubbed DOM, wires up a fake 60fps
 * YouTube player, drives a manual requestAnimationFrame clock, and counts how
 * many times the canvas is actually painted.
 *
 * Run with `node test/engine.mjs`.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
};

const SRC = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

function makeEl(tag, cls = '') {
  const el = {
    tagName: tag.toUpperCase(),
    className: cls,
    children: [],
    parentElement: null,
    style: {},
    listeners: {},
    offsetLeft: 0,
    offsetTop: 0,
    offsetWidth: 1920,
    offsetHeight: 1080,
    classList: {
      _s: new Set(cls.split(' ').filter(Boolean)),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    textContent: '',
    appendChild(c) { c.parentElement = el; el.children.push(c); return c; },
    append(...nodes) { for (const n of nodes) el.appendChild(n); },
    remove() {
      if (!el.parentElement) return;
      const a = el.parentElement.children;
      a.splice(a.indexOf(el), 1);
      el.parentElement = null;
    },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    closest(sel) {
      let n = el;
      while (n) {
        if (sel.slice(1).split('.').every((c) => n.classList.contains(c))) return n;
        n = n.parentElement;
      }
      return null;
    },
  };
  return el;
}

/** A player subtree plus the harness needed to run the engine against it. */
function harness({ settings: initial, sourceFps = 60, refreshHz = 120 }) {
  // Clone: setSetting() mutates this, and callers share one BASE object.
  const settings = { ...initial };
  const player = makeEl('div', 'html5-video-player');
  const container = makeEl('div', 'html5-video-container');
  const video = makeEl('video', 'html5-main-video');
  player.appendChild(container);
  container.appendChild(video);

  Object.assign(video, {
    videoWidth: 3840,
    videoHeight: 2160,
    currentTime: 0,
    paused: false,
    getVideoPlaybackQuality: () => ({ droppedVideoFrames: 0, totalVideoFrames: 100 }),
  });

  let draws = 0;
  const drawTimes = [];
  let now = 0;
  let tick = 0;
  let rafSeq = 1;
  let rafQueue = new Map();

  const ctx = {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    drawImage() { draws++; drawTimes.push(now); },
  };

  const canvasFactory = () => {
    const c = makeEl('canvas');
    c.width = 300;
    c.height = 150;
    c.getContext = () => ctx;
    return c;
  };

  const sandbox = {
    console,
    performance: { now: () => now },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame(fn) { const id = rafSeq++; rafQueue.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafQueue.delete(id); },
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  };

  sandbox.window = {
    devicePixelRatio: 1,
    listeners: {},
    addEventListener(t, fn) { (sandbox.window.listeners[t] ||= []).push(fn); },
    postMessage() {},
  };

  sandbox.document = {
    head: makeEl('head'),
    documentElement: makeEl('html'),
    pictureInPictureElement: null,
    listeners: {},
    addEventListener(t, fn) { (sandbox.document.listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    createElement: (tag) =>
      tag === 'canvas' ? canvasFactory() : Object.assign(makeEl(tag), { dataset: {} }),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    querySelector: (sel) => (sel === 'video.html5-main-video' ? video : null),
    getElementById: () => null,
  };

  const area = {
    get: async () => ({ ...settings }),
    set: async () => {},
  };
  const changeListeners = [];
  sandbox.chrome = {
    runtime: { getURL: (p) => 'chrome-extension://test/' + p },
    storage: {
      local: area,
      sync: area,
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const api = {
    player,
    video,
    canvas: () => container.children.find((c) => c.tagName === 'CANVAS'),
    draws: () => draws,
    drawTimes: () => drawTimes,
    /* start() primes the canvas with one immediate paint so it is never blank;
       clear the counters to measure steady-state cadence only. */
    reset() { draws = 0; drawTimes.length = 0; },
    /** Report player state the way inject.js would. */
    sendState(extra = {}) {
      for (const fn of sandbox.window.listeners.message || []) {
        fn({
          source: sandbox.window,
          data: {
            tag: 'absolute-cinema:to-content',
            type: 'state',
            payload: {
              videoId: 'vid1', picked: 'hd2160', pickedLabel: '2160p60',
              currentLabel: '2160p60', currentFps: sourceFps,
              adShowing: false, ...extra,
            },
          },
        });
      }
    },
    /** Advance the fake display clock by `seconds`, running rAF each vsync. */
    run(seconds) {
      const ticks = Math.round(refreshHz * seconds);
      for (let i = 0; i < ticks; i++) {
        tick++;
        now = (tick * 1000) / refreshHz;
        video.currentTime = tick / refreshHz;
        const due = rafQueue;
        rafQueue = new Map();
        for (const fn of due.values()) fn(now);
      }
    },
    fire(type) {
      for (const fn of sandbox.document.listeners[type] || []) fn();
    },
    /** Change a setting the way the popup does: write, then notify. */
    setSetting(patch, areaName = 'sync') {
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        changes[k] = { oldValue: settings[k], newValue: v };
      }
      Object.assign(settings, patch);
      for (const fn of changeListeners) fn(changes, areaName);
    },
    cinemaOn: () => player.classList.contains('ac-cinema-on'),
  };
  return api;
}

const BASE = {
  enabled: true, quality: 'hd2160', fpsCap: 24,
  fpsMode: 'cinematic', badge: true, diag: false,
};

console.log('cinematic engine');

/* loadSettings() awaits two async storage reads before assigning `settings`
   and calling scan(), so the boot path needs the whole microtask queue
   drained — not a fixed number of `await null`s. */
const flush = () => new Promise((r) => setImmediate(r));

const boot = async (opts) => {
  const h = harness(opts);
  await flush();
  h.fire('yt-navigate-finished'); // navigation lands first...
  h.sendState();                  // ...then the page script reports the player
  await flush();
  return h;
};

const h24 = await boot({ settings: BASE });

check('a canvas is inserted next to the video', () =>
  assert.ok(h24.canvas(), 'no canvas was appended to the video container')
);

check('the player is marked so CSS can hide the source video', () =>
  assert.ok(h24.player.classList.contains('ac-cinema-on'))
);

check('start() primes the canvas with exactly one paint', () => {
  assert.equal(h24.draws(), 1);
});

h24.run(0.5);
h24.reset();
h24.run(1);

const near = (got, want, label) =>
  assert.ok(Math.abs(got - want) <= 1, `${label}: got ${got}, wanted ~${want}`);

check('a 60fps source under a 24fps cap paints ~24 times in one second', () =>
  near(h24.draws(), 24, 'paints')
);

check('repaints land on an even grid at 120Hz', () => {
  const t = h24.drawTimes();
  const gaps = t.slice(1).map((v, i) => Math.round(v - t[i]));
  assert.deepEqual([...new Set(gaps)], [Math.round(1000 / 24)]);
});

const h30 = await boot({ settings: { ...BASE, fpsCap: 30 } });
h30.run(0.5);
h30.reset();
h30.run(1);
check('a 30fps cap paints ~30 times in one second', () =>
  near(h30.draws(), 30, 'paints')
);

const h60hz = await boot({ settings: BASE, refreshHz: 60 });
h60hz.run(0.5);
h60hz.reset();
h60hz.run(1);
check('a 24fps cap on a 60Hz panel paints ~24 times in one second', () =>
  near(h60hz.draws(), 24, 'paints')
);

check('a 60Hz panel shows the inherent 3:2 pulldown, not random judder', () => {
  const t = h60hz.drawTimes();
  const gaps = t.slice(1).map((v, i) => Math.round(v - t[i]));
  assert.deepEqual([...new Set(gaps)].sort((a, b) => a - b), [33, 50]);
});

const hOff = await boot({ settings: { ...BASE, fpsCap: 0 } });
hOff.run(1);
check('cap off inserts no canvas and paints nothing', () => {
  assert.equal(hOff.canvas(), undefined);
  assert.equal(hOff.draws(), 0);
});

const hStream = await boot({ settings: { ...BASE, fpsMode: 'stream' } });
hStream.run(1);
check('stream mode does not run the canvas engine', () => {
  assert.equal(hStream.canvas(), undefined);
  assert.equal(hStream.draws(), 0);
});

const hLow = await boot({ settings: BASE, sourceFps: 24 });
hLow.run(1);
check('a source already at the cap is left untouched', () => {
  assert.equal(hLow.canvas(), undefined);
  assert.equal(hLow.draws(), 0);
});

const hDis = await boot({ settings: { ...BASE, enabled: false } });
hDis.run(1);
check('disabled master switch paints nothing', () =>
  assert.equal(hDis.draws(), 0)
);

console.log('\nruntime setting changes');

const hT = await boot({ settings: BASE });
hT.run(0.5);
check('engine is running before the change', () => {
  assert.ok(hT.canvas());
  assert.ok(hT.cinemaOn());
});

hT.setSetting({ fpsCap: 0 });
hT.reset();
hT.run(1);

check('selecting Off tears the canvas down', () =>
  assert.equal(hT.canvas(), undefined, 'canvas survived the cap being turned off')
);

check('selecting Off unhides the source video', () =>
  assert.equal(hT.cinemaOn(), false, 'ac-cinema-on left on the player')
);

check('selecting Off stops all repainting', () =>
  assert.equal(hT.draws(), 0, 'still painting after the cap was turned off')
);

const hM = await boot({ settings: BASE });
hM.run(0.5);
hM.setSetting({ fpsMode: 'stream' });
hM.reset();
hM.run(1);
check('switching to stream mode tears the canvas down', () => {
  assert.equal(hM.canvas(), undefined);
  assert.equal(hM.draws(), 0);
});

const hE = await boot({ settings: BASE });
hE.run(0.5);
hE.setSetting({ enabled: false });
hE.reset();
hE.run(1);
check('the master switch tears the canvas down', () => {
  assert.equal(hE.canvas(), undefined);
  assert.equal(hE.draws(), 0);
});

const hOn = await boot({ settings: { ...BASE, fpsCap: 0 } });
hOn.run(0.5);
hOn.setSetting({ fpsCap: 24 });
hOn.reset();
hOn.run(1);
check('turning the cap back on starts the engine without a reload', () => {
  assert.ok(hOn.canvas(), 'no canvas after enabling the cap at runtime');
  near(hOn.draws(), 24, 'paints');
});

const hC = await boot({ settings: BASE });
hC.run(0.5);
hC.setSetting({ fpsCap: 30 });
hC.reset();
hC.run(1);
check('changing 24 -> 30 repaces to the new cap', () =>
  near(hC.draws(), 30, 'paints')
);

console.log(`\n${pass} passed`);
