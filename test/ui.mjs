/*
 * Contract between src/ui.html, src/ui.js and the engine's expectations.
 *
 * ui.js sets every field in render() in sequence; a single missing element
 * throws partway through, leaving the radio groups unset. The next change
 * event then persists whatever the half-rendered form reads back — silently
 * writing fpsCap: 0. Cheap to check statically, expensive to notice by hand.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const html = read('ui.html');
const uijs = read('ui.js');
const inject = read('inject.js');
const content = read('content.js');

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

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag, a) => (tag.match(new RegExp(`\\b${a}="([^"]*)"`)) || [])[1];
const valuesFor = (name) =>
  inputs.filter((i) => attr(i, 'name') === name).map((i) => attr(i, 'value'));

console.log('ui contract');

check('every $("#id") in ui.js exists in ui.html', () => {
  const wanted = [...uijs.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 5, 'expected several id lookups');
  const missing = wanted.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `ui.js reads ids absent from ui.html: ${missing}`);
});

check('every radio group ui.js queries exists in ui.html', () => {
  const groups = [...uijs.matchAll(/input\[name="\$\{name\}"\]/g)];
  assert.ok(groups.length, 'radios() helper not found');
  for (const g of ['fps', 'mode']) {
    assert.ok(valuesFor(g).length >= 2, `no <input name="${g}"> group in ui.html`);
  }
});

check('frame-rate radios offer exactly off / 24 / 30', () =>
  assert.deepEqual(valuesFor('fps'), ['0', '24', '30'])
);

check('method radios match the modes content.js branches on', () => {
  assert.deepEqual(valuesFor('mode'), ['cinematic', 'stream']);
  assert.ok(content.includes("settings.fpsMode === 'cinematic'"));
  assert.ok(content.includes("settings.fpsMode === 'stream'"));
});

check('every setting in DEFAULTS has a control in ui.html', () => {
  const block = content.match(/const DEFAULTS = \{([\s\S]*?)\};/)[1];
  const keys = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ['badge', 'diag', 'enabled', 'fpsCap', 'fpsMode', 'quality']);
  for (const [key, control] of [
    ['enabled', () => ids.has('enabled')],
    ['quality', () => ids.has('quality')],
    ['badge', () => ids.has('badge')],
    ['diag', () => ids.has('diag')],
    ['fpsCap', () => valuesFor('fps').length === 3],
    ['fpsMode', () => valuesFor('mode').length === 2],
  ]) {
    assert.ok(control(), `no control in ui.html for setting "${key}"`);
  }
});

check('ui.js and content.js agree on the DEFAULTS shape', () => {
  const shape = (src) => {
    const b = src.match(/DEFAULTS = \{([\s\S]*?)\};/)[1];
    return [...b.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
  };
  assert.deepEqual(shape(uijs), shape(content));
});

check('quality options are all tokens inject.js knows', () => {
  const ladder = new Set(
    [...inject.matchAll(/\['(\w+)',\s*\d+\]/g)].map((m) => m[1])
  );
  ladder.add('auto');
  assert.ok(ladder.size > 5, 'could not parse the quality ladder');
  const opts = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  const unknown = opts.filter((o) => !ladder.has(o));
  assert.deepEqual(unknown, [], `ui.html offers qualities inject.js cannot map: ${unknown}`);
});

check('every input is nested in a label, so the NeoPOP faces stay clickable', () => {
  // The visible face is a sibling <span>; the input carries pointer-events:none,
  // so activation depends entirely on label wrapping.
  const labels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) => m[0]);
  const wrapped = labels.join('');
  const orphans = inputs.filter((i) => !wrapped.includes(i));
  assert.deepEqual(orphans, [], `inputs outside any <label>: ${orphans}`);
});

console.log(`\n${pass} passed`);
