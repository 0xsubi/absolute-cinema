/* Every path the manifest and stylesheets reference must exist in the package,
   and the rules the engine depends on must still be present. */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => path.join(root, p);
const read = (p) => readFileSync(at(p), 'utf8');

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const m = JSON.parse(read('manifest.json'));
console.log('package integrity');

check('manifest still declares every top-level key', () =>
  assert.deepEqual(Object.keys(m).sort(), [
    'action', 'browser_specific_settings', 'content_scripts', 'description',
    'icons', 'manifest_version', 'name', 'options_ui', 'permissions',
    'version', 'web_accessible_resources',
  ])
);

check('every file the manifest names exists', () => {
  const paths = [
    ...Object.values(m.icons),
    ...Object.values(m.action.default_icon),
    m.action.default_popup,
    m.options_ui.page,
    ...m.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ...m.web_accessible_resources.flatMap((w) => w.resources),
  ];
  const missing = paths.filter((p) => !existsSync(at(p)));
  assert.deepEqual(missing, [], `declared but absent: ${missing}`);
});

check('the content script injects both stylesheets, tokens first', () =>
  assert.deepEqual(m.content_scripts[0].css, ['src/neopop.css', 'src/overlay.css'])
);

check('inject.js is web-accessible, or the page bridge never loads', () =>
  assert.ok(m.web_accessible_resources.some((w) => w.resources.includes('src/inject.js')))
);

check('every url() in the injected CSS resolves', () => {
  for (const css of m.content_scripts[0].css) {
    const dir = path.dirname(at(css));
    // group 1 is the quote character, group 2 is the path
    for (const [, , u] of read(css).matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
      if (u.startsWith('data:')) continue;
      assert.ok(existsSync(path.resolve(dir, u)), `${css} references missing ${u}`);
    }
  }
});

check('the rule that hides the source video survives', () => {
  const css = read('src/overlay.css');
  assert.match(css, /\.html5-video-player\.ac-cinema-on\s+video\.html5-main-video\s*\{[^}]*opacity:\s*0\s*!important/);
});

check('content.js still adds the class that rule keys on', () =>
  assert.match(read('src/content.js'), /classList\.add\('ac-cinema-on'\)/)
);

check('the canvas is positioned above the video', () =>
  assert.match(read('src/overlay.css'), /canvas\.ac-canvas\s*\{[^}]*position:\s*absolute[^}]*\}/s)
);

console.log(`\n${pass} passed`);
