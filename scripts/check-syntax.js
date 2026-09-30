// The server is plain JavaScript (no bundling step). "Build" = syntax-check every source file and import the app graph.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed += 1; console.error(`Syntax error in ${f}\n${r.stderr}`); }
}
// Importing app.js resolves every import path in the route/controller/service graph without opening a port.
const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "const { createApp } = await import('./src/app.js'); createApp(); console.log('app graph OK');"], { cwd: join(root, '..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ENABLE_JOBS: 'false' } });
if (probe.status !== 0) { failed += 1; console.error(probe.stderr || probe.stdout); } else process.stdout.write(probe.stdout);
console.log(`${files.length} files checked, ${failed} problem(s)`);
process.exit(failed ? 1 : 0);
