/* Headless exercise of the two pieces with real decision logic in them:
   the quality/fps stream chooser in inject.js, and the cadence gate in
   content.js. Run with `node test/run.mjs`. */
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

// ---------------------------------------------------------------- harness

function makePlayer(qualities) {
  const calls = [];
  return {
    calls,
    classList: { contains: () => false },
    getAvailableQualityLevels: () => qualities.map((q) => q.quality),
    getAvailableQualityData: () => qualities,
    getPlaybackQuality: () => calls.at(-1) || 'auto',
    getVideoData: () => ({ video_id: 'testvid' }),
    setPlaybackQualityRange: (a) => calls.push(a),
    setPlaybackQuality: () => {},
  };
}

const injectSrc = readFileSync(new URL('../src/inject.js', import.meta.url), 'utf8');

/** Boot inject.js against a fake player, push settings, return chosen token. */
function pick(qualities, settings) {
  const player = makePlayer(qualities);
  const listeners = { window: [], document: [] };
  const ctx = {
    setTimeout: (fn) => (fn(), 0), // collapse the retry schedule
    clearTimeout: () => {},
    console,
  };
  ctx.window = {
    addEventListener: (t, fn) => t === 'message' && listeners.window.push(fn),
    postMessage(data) {
      for (const fn of listeners.window) fn({ source: ctx.window, data });
    },
  };
  ctx.document = {
    addEventListener: (t, fn) => listeners.document.push(fn),
    getElementById: (id) => (id === 'movie_player' ? player : null),
    querySelector: () => null,
  };
  ctx.location = { href: 'https://www.youtube.com/watch?v=testvid' };
  vm.createContext(ctx);
  vm.runInContext(injectSrc, ctx);
  ctx.window.postMessage({
    tag: 'absolute-cinema:to-page',
    type: 'settings',
    payload: settings,
  });
  return player.calls.at(-1) || null;
}

const q = (quality, qualityLabel) => ({ quality, qualityLabel, isPlayable: true });

// A typical 60fps 4K music-video upload: 60fps down to 720p, 30fps below.
const SIXTY_4K = [
  q('hd2160', '2160p60'),
  q('hd1440', '1440p60'),
  q('hd1080', '1080p60'),
  q('hd720', '720p60'),
  q('large', '480p'),
  q('medium', '360p'),
  q('small', '240p'),
  q('tiny', '144p'),
];

// A plain 30fps upload topping out at 1080p.
const THIRTY_1080 = [
  q('hd1080', '1080p'),
  q('hd720', '720p'),
  q('large', '480p'),
  q('medium', '360p'),
];

const base = { enabled: true, quality: 'hd2160', fpsCap: 0, fpsMode: 'cinematic' };

console.log('quality selection');

check('exact quality is honoured when available', () =>
  assert.equal(pick(SIXTY_4K, { ...base, quality: 'hd2160' }), 'hd2160')
);

check('8K request falls back to the next best available', () =>
  assert.equal(pick(SIXTY_4K, { ...base, quality: 'highres' }), 'hd2160')
);

check('quality acts as a ceiling, not a floor', () =>
  assert.equal(pick(SIXTY_4K, { ...base, quality: 'hd1080' }), 'hd1080')
);

check('4K request on a 1080p video lands on 1080p', () =>
  assert.equal(pick(THIRTY_1080, { ...base, quality: 'hd2160' }), 'hd1080')
);

check('auto leaves the ladder untouched and takes the best', () =>
  assert.equal(pick(SIXTY_4K, { ...base, quality: 'auto' }), 'hd2160')
);

check('unplayable tiers are skipped', () =>
  assert.equal(
    pick(
      [
        { quality: 'hd2160', qualityLabel: '2160p60', isPlayable: false },
        q('hd1440', '1440p60'),
      ],
      { ...base, quality: 'hd2160' }
    ),
    'hd1440'
  )
);

console.log('\ncinematic mode leaves streams alone');

check('cinematic 24 still selects 4K60', () =>
  assert.equal(
    pick(SIXTY_4K, { ...base, fpsCap: 24, fpsMode: 'cinematic' }),
    'hd2160'
  )
);

console.log('\nstream mode');

check('stream 30 drops a 60fps upload to 480p', () =>
  assert.equal(pick(SIXTY_4K, { ...base, fpsCap: 30, fpsMode: 'stream' }), 'large')
);

check('stream 24 has nothing to hit, so takes the lowest rate on offer', () =>
  assert.equal(pick(SIXTY_4K, { ...base, fpsCap: 24, fpsMode: 'stream' }), 'large')
);

check('stream mode is a no-op on an already-30fps video', () =>
  assert.equal(
    pick(THIRTY_1080, { ...base, fpsCap: 30, fpsMode: 'stream' }),
    'hd1080'
  )
);

check('quality ceiling is applied before the fps filter', () =>
  assert.equal(
    pick(SIXTY_4K, { ...base, quality: 'medium', fpsCap: 30, fpsMode: 'stream' }),
    'medium'
  )
);

check('players exposing no fps labels ignore the fps filter', () =>
  assert.equal(
    pick(
      [{ quality: 'hd2160' }, { quality: 'hd1080' }].map((x) => ({
        ...x,
        isPlayable: true,
      })),
      { ...base, fpsCap: 30, fpsMode: 'stream' }
    ),
    'hd2160'
  )
);

console.log('\ncadence gate');

/*
 * Mirrors Cinema.pump + Cinema.onFrame: walk the clock's ticks, and repaint
 * whenever media time crosses into a new target-fps slot.
 *
 * `eligible` is what distinguishes the two pacing clocks. rAF can fire on
 * every vsync; rVFC only fires on vsyncs where a video frame was also
 * presented, which is every (refreshHz / sourceFps)-th one.
 */
function repaints({ refreshHz, targetFps, sourceFps = null, seconds = 1 }) {
  const stride = sourceFps ? refreshHz / sourceFps : 1;
  const ticks = Math.round(refreshHz * seconds);
  const at = [];
  let last = -1;
  for (let i = 0; i < ticks; i++) {
    if (i % stride !== 0) continue; // rVFC: no video frame on this vsync
    const index = Math.floor((i / refreshHz) * targetFps);
    if (index === last) continue;
    last = index;
    at.push(i);
  }
  return at;
}

const gapsOf = (at) => at.slice(1).map((v, i) => v - at[i]);
const spread = (g) => Math.max(...g) - Math.min(...g);

check('60fps source at a 24fps cap paints 24 times per second', () =>
  assert.equal(repaints({ refreshHz: 120, targetFps: 24 }).length, 24)
);

check('60fps source at a 30fps cap paints 30 times per second', () =>
  assert.equal(repaints({ refreshHz: 120, targetFps: 30 }).length, 30)
);

check('cadence holds over a longer run', () =>
  assert.equal(repaints({ refreshHz: 120, targetFps: 24, seconds: 10 }).length, 240)
);

check('rAF clock on a 120Hz panel gives a perfectly even 24fps grid', () =>
  assert.deepEqual(
    [...new Set(gapsOf(repaints({ refreshHz: 120, targetFps: 24 })))],
    [5]
  )
);

check('rAF clock on a 60Hz panel gives the inherent 3:2 pulldown', () =>
  assert.deepEqual(
    [...new Set(gapsOf(repaints({ refreshHz: 60, targetFps: 24 })))].sort(),
    [2, 3]
  )
);

check('rAF clock on a 60Hz panel is perfectly even at 30fps', () =>
  assert.deepEqual(
    [...new Set(gapsOf(repaints({ refreshHz: 60, targetFps: 30 })))],
    [2]
  )
);

// The regression this replaced: pacing off rVFC could only ever fire on every
// other vsync at 120Hz, forcing a clean 5-5-5 grid into 6-4-6-4.
check('rVFC clock on a 120Hz panel would judder where rAF does not', () => {
  const viaRvfc = gapsOf(repaints({ refreshHz: 120, targetFps: 24, sourceFps: 60 }));
  const viaRaf = gapsOf(repaints({ refreshHz: 120, targetFps: 24 }));
  assert.deepEqual([...new Set(viaRvfc)].sort(), [4, 6]);
  assert.equal(spread(viaRvfc), 2);
  assert.equal(spread(viaRaf), 0);
});

check('both clocks agree on a 60Hz panel, so 60Hz users saw no regression', () =>
  assert.deepEqual(
    gapsOf(repaints({ refreshHz: 60, targetFps: 24, sourceFps: 60 })),
    gapsOf(repaints({ refreshHz: 60, targetFps: 24 }))
  )
);

check('a 30fps source under a 30fps cap paints every frame', () =>
  assert.equal(repaints({ refreshHz: 60, targetFps: 30 }).length, 30)
);

console.log(`\n${pass} passed`);
