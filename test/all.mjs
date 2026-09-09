/* Runs every suite. `node test/all.mjs` */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = fileURLToPath(new URL('.', import.meta.url));
const suites = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'all.mjs').sort();

let failed = 0;
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
  console.log('');
}
console.log(failed ? `${failed}/${suites.length} suites FAILED` : `${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
