/*
 * Runs the real src/ui.js against a DOM built from the real src/ui.html.
 *
 * The popup is the half the engine tests can't see: if it persists the wrong
 * value, every downstream component behaves correctly on bad input and the
 * bug looks like an engine fault.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const html = src('ui.html');
const UIJS = src('ui.js');

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const attr = (tag, a) => (tag.match(new RegExp(`\\b${a}="([^"]*)"`)) || [])[1];

/** Build a stub DOM from ui.html and run ui.js in it. */
function popup(stored) {
  const wrap = { className: 'wrap' };
  const els = [];

  for (const tag of html.match(/<input\b[^>]*>/g) || []) {
    els.push({
      tag: 'input', type: attr(tag, 'type') || 'text',
      id: attr(tag, 'id'), name: attr(tag, 'name'), value: attr(tag, 'value'),
      checked: false, closest: (s) => (s === '.wrap' ? wrap : null),
    });
  }
  for (const m of html.matchAll(/<select\b[^>]*\bid="([^"]+)"/g)) {
    els.push({ tag: 'select', id: m[1], value: '', closest: () => wrap });
  }
  for (const id of ['warn', 'saved']) {
    els.push({ tag: 'p', id, hidden: false, textContent: '', closest: () => wrap });
  }

  const byId = (id) => els.find((e) => e.id === id) || null;
  const writes = { local: [], sync: [] };
  const listeners = {};

  const mkArea = (name, seed, fail = false) => ({
    get: async () => (fail ? Promise.reject(new Error('unavailable')) : { ...seed }),
    set: async (v) => {
      if (fail) throw new Error('unavailable');
      writes[name].push({ ...v });
    },
  });

  const sandbox = {
    console, setTimeout: () => 0, clearTimeout: () => {}, Promise,
    document: {
      body: { classList: { toggle() {} } },
      addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
      querySelector: (sel) => (sel.startsWith('#') ? byId(sel.slice(1)) : null),
      querySelectorAll: (sel) => {
        const m = sel.match(/^input\[name="([^"]+)"\]$/);
        return m ? els.filter((e) => e.name === m[1]) : [];
      },
    },
  };
  sandbox.chrome = {
    storage: {
      local: mkArea('local', stored.local ?? stored, stored.localFails),
      sync: mkArea('sync', stored.sync ?? stored, stored.syncFails),
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(UIJS, sandbox);

  return {
    byId,
    writes,
    radio: (name, value) => els.find((e) => e.name === name && e.value === value),
    checkedValue: (name) => (els.find((e) => e.name === name && e.checked) || {}).value,
    /** Click a radio the way a browser would: it unchecks its group siblings. */
    click(name, value) {
      for (const e of els) if (e.name === name) e.checked = e.value === value;
      const target = this.radio(name, value);
      for (const fn of listeners.change || []) fn({ target });
    },
    toggle(id) {
      const e = byId(id);
      e.checked = !e.checked;
      for (const fn of listeners.change || []) fn({ target: e });
    },
    flush: () => new Promise((r) => setImmediate(r)),
  };
}

const STORED = {
  enabled: true, quality: 'hd1440', fpsCap: 24,
  fpsMode: 'cinematic', badge: true, diag: false,
};

console.log('popup');

const p = popup(STORED);
await p.flush();

check('render() checks the radio matching the stored cap', () =>
  assert.equal(p.checkedValue('fps'), '24')
);

check('render() restores the stored quality and mode', () => {
  assert.equal(p.byId('quality').value, 'hd1440');
  assert.equal(p.checkedValue('mode'), 'cinematic');
});

p.click('fps', '0');
await p.flush();

check('selecting Off persists fpsCap 0, not a stale 24', () => {
  const last = p.writes.sync.at(-1);
  assert.ok(last, 'nothing was written to sync');
  assert.equal(last.fpsCap, 0);
});

check('selecting Off writes to BOTH storage areas', () => {
  assert.equal(p.writes.local.at(-1).fpsCap, 0);
  assert.equal(p.writes.sync.at(-1).fpsCap, 0);
});

check('a save carries every setting, not just the changed one', () => {
  assert.deepEqual(
    Object.keys(p.writes.sync.at(-1)).sort(),
    ['badge', 'diag', 'enabled', 'fpsCap', 'fpsMode', 'quality']
  );
});

check('fpsCap is persisted as a number, so cap > 0 works in content.js', () => {
  const v = p.writes.sync.at(-1).fpsCap;
  assert.equal(typeof v, 'number', `fpsCap saved as ${typeof v}`);
});

p.click('fps', '30');
await p.flush();
check('switching Off -> 30 persists 30', () =>
  assert.equal(p.writes.sync.at(-1).fpsCap, 30)
);

// The divergence that made "Off" appear to revert: sync unusable, so only
// local could ever be written, while content.js lets sync win on load.
const q = popup({ ...STORED, syncFails: true });
await q.flush();
q.click('fps', '0');
await q.flush();

check('with sync unavailable, local is still written', () =>
  assert.equal(q.writes.local.at(-1).fpsCap, 0)
);

check('a half-failed save still reports success', () =>
  assert.equal(q.byId('saved').textContent, 'Saved')
);

const r = popup(STORED);
await r.flush();
r.click('mode', 'stream');
await r.flush();
check('the 480p warning appears only in stream mode with a cap set', () =>
  assert.equal(r.byId('warn').hidden, false)
);

console.log(`\n${pass} passed`);
