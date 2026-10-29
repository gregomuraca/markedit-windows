import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

let notices = 'MarkEdit for Windows — Rust edition\nOriginal MarkEdit © 2023 MarkEdit.app, MIT.\nIndependent community adaptation, not an official MarkEdit release.\n\nDependency license texts (including build tools) follow.\n';
async function licenses(folder, label) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!/^(licen[cs]e|copying|notice)([-._]|$)/i.test(entry.name)) continue;
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      for (const child of await readdir(filename, { withFileTypes: true })) {
        if (child.isFile()) notices += `\n--- ${label} / ${entry.name}/${child.name} ---\n${await readFile(path.join(filename, child.name), 'utf8')}\n`;
      }
    } else notices += `\n--- ${label} / ${entry.name} ---\n${await readFile(filename, 'utf8')}\n`;
  }
}
async function npmPackages(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const dir = path.join(folder, entry.name);
    if (entry.name.startsWith('@')) { await npmPackages(dir); continue; }
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}'));
    if (pkg.name) await licenses(dir, `${pkg.name} ${pkg.version}`);
  }
}
await npmPackages('node_modules');
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
for (const pkg of metadata.packages) {
  notices += `\nRust dependency: ${pkg.name} ${pkg.version} — ${pkg.license || 'see license file'}\n`;
  await licenses(path.dirname(pkg.manifest_path), `${pkg.name} ${pkg.version}`);
}
await writeFile('THIRD-PARTY-NOTICES.txt', notices);
console.log('Wrote JavaScript and Rust dependency notices.');
