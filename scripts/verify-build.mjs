// Fails the build if the packaged exe is missing its security fuses or app files.
// Usage: node scripts/verify-build.mjs [path/to/exe]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(path.join(root, 'package.json'));
const { getCurrentFuseWire, FuseV1Options: F } = require('@electron/fuses');
const asar = require('@electron/asar');
const pkg = require('./package.json');

const exe = process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(root, 'dist', 'win-unpacked', `${pkg.build.productName}.exe`);
const want = {
  RunAsNode: '0', EnableCookieEncryption: '1', EnableNodeOptionsEnvironmentVariable: '0',
  EnableNodeCliInspectArguments: '0', EnableEmbeddedAsarIntegrityValidation: '1', OnlyLoadAppFromAsar: '1',
};
const wire = await getCurrentFuseWire(exe);
const errors = [];
for (const [k, v] of Object.entries(want)) {
  const got = String.fromCharCode(wire[F[k]]);
  if (got !== v) errors.push(`fuse ${k} is ${got}, expected ${v}`);
}
const asarPath = path.join(path.dirname(exe), 'resources', 'app.asar');
const files = new Set(asar.listPackage(asarPath).map(f => f.replace(/\\/g, '/').replace(/^\//, '')));
for (const f of pkg.build.files) if (!files.has(f)) errors.push(`app.asar is missing ${f}`);
// Besides the app files, only the declared runtime dependencies may be bundled.
const runtimeDeps = Object.keys(pkg.dependencies || {});
const extra = [...files].filter(f => !pkg.build.files.includes(f) && !f.startsWith('node_modules/') && f !== 'node_modules');
for (const dep of runtimeDeps) if (![...files].some(f => f.startsWith(`node_modules/${dep}/`))) errors.push(`app.asar is missing dependency ${dep}`);
if (process.argv.includes('--installer')) {
  const yml = path.join(path.dirname(exe), 'resources', 'app-update.yml');
  if (!fs.existsSync(yml) || !/provider: github/.test(fs.readFileSync(yml, 'utf8'))) errors.push('resources/app-update.yml missing or not pointing at GitHub');
}
if (extra.length) errors.push(`app.asar has unexpected files: ${extra.join(', ')}`);
if (errors.length) { console.error('Build verification FAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log(`Build verified: ${Object.keys(want).length} fuses set; app.asar holds the ${pkg.build.files.length} app files plus ${runtimeDeps.length} runtime dependenc${runtimeDeps.length === 1 ? 'y' : 'ies'}.`);
