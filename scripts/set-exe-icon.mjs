// Sets the Windows exe's icon and version info after electron-builder runs.
// Usage: node scripts/set-exe-icon.mjs [path/to/exe]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(path.join(root, 'package.json'));
const ResEdit = require('resedit');
const { makeIco } = require('./lib.js');
const pkg = require('./package.json');

const exePath = process.argv[2] || path.join(root, 'dist', 'win-unpacked', `${pkg.build.productName}.exe`);
const [maj, min, pat] = pkg.version.split('.').map(Number);

const ico = makeIco();
fs.writeFileSync(path.join(root, 'icon.ico'), ico);

const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries, groups.length ? groups[0].id : 1, groups.length ? groups[0].lang : 1033,
  ResEdit.Data.IconFile.from(ico).icons.map(i => i.data),
);
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: pkg.build.productName, ProductName: pkg.build.productName, CompanyName: pkg.author,
  OriginalFilename: `${pkg.build.productName}.exe`, InternalName: pkg.build.productName, LegalCopyright: `MIT License, ${pkg.author}`,
});
vi.setFileVersion(maj, min, pat, 0, 1033);
vi.setProductVersion(maj, min, pat, 0, 1033);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`Set icon and version ${pkg.version} on ${path.basename(exePath)}`);
