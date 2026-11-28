// Desktop Wallet release packager (W1). Builds every platform's app from the pinned official Electron download,
// with app.asar added and the security fuses flipped, ready to be signed. See README.md in this folder.
//   node desktop/release/package-release.mjs [--only linux-x64,...] [--electron-cache DIR]
//   node desktop/release/package-release.mjs --sums DIR      (SHA256SUMS for the final, signed files)
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'tools/desktop-deps/package.json'));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
export const ELECTRON = '45.4.1';
export const PINS = {
  'win32-x64': '2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9', 'win32-arm64': '5ad2f09093cba71ad7dc8ddb2ef7261978c9130aa07e492556efe802f6ca74e9',
  'darwin-arm64': 'd080c3b05a01bd16137f2c12ab9ebf083c577757fe846844ba325bafa8e8bdf4', 'darwin-x64': '1c80d2ccf71b02c8fd9940fd09cafe88090a48c1bab0193c79b597b08d890e79',
  'linux-x64': 'e1d077c7a087d7e344350ea0c5cd2b7dc5af3d9bf7979474f38e0fc1a560b875', 'linux-arm64': '3da04c450fa682e3b80961e92a918a1c2a1a10796527a7e63dec7b8e466b6334' };
const NAME = 'Parano1d World Wallet';

export function writeSums(dir) {
  const files = fs.readdirSync(dir).filter(f => f !== 'SHA256SUMS' && fs.statSync(path.join(dir, f)).isFile()).sort();
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), files.map(f => `${sha(path.join(dir, f))}  ${f}`).join('\n') + '\n');
  return files.length;
}

/** Flip the fuses in one Electron binary (same layout check as the installers). asarIntegrity only where supported. */
export function flipFuses(bin, asarIntegrity) {
  const b = fs.readFileSync(bin), i = b.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'); if (i < 0) throw Error('no fuse wire in ' + bin);
  const w = i + 32; if (b[w] !== 1) throw Error('unexpected fuse version in ' + bin);
  const n = b[w + 1], set = { 0: 48, 1: 49, 2: 48, 3: 48, 5: 49, 7: 48, ...(asarIntegrity ? { 4: 49 } : {}) };
  for (const [k, v] of Object.entries(set)) if (+k < n && b[w + 2 + +k] !== 114) b[w + 2 + +k] = v;
  fs.writeFileSync(bin, b);
}

async function build({ only, cache }) {
  const { buildDesktop } = await import(path.join(root, 'tools/build-desktop.mjs'));
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  const out = path.join(root, 'dist-desktop', version), work = fs.mkdtempSync('/tmp/p1w-rel-');
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const parts = path.join(work, 'parts'); await buildDesktop({ out: parts });   // app.asar + icons from the tested release/
  const asar = req('@electron/asar'), asarFile = path.join(parts, 'app.asar');
  const headerSha = crypto.createHash('sha256').update(asar.getRawHeader(asarFile).headerString).digest('hex');
  for (const plat of Object.keys(PINS).filter(p => !only || only.includes(p.replace('win32', 'windows').replace('darwin', 'mac')) || only.includes(p))) {
    const [os, arch] = plat.split('-'), zip = path.join(cache || work, `electron-v${ELECTRON}-${plat}.zip`);
    if (!fs.existsSync(zip)) execFileSync('curl', ['-fsSL', '--proto', '=https', '-o', zip, `https://github.com/electron/electron/releases/download/v${ELECTRON}/electron-v${ELECTRON}-${plat}.zip`]);
    if (sha(zip) !== PINS[plat]) throw Error(`Electron ${plat} does not match its pinned SHA-256`);
    const d = path.join(work, plat); fs.mkdirSync(d); execFileSync('unzip', ['-q', zip, '-d', d]);
    if (os === 'darwin') {
      const app = path.join(d, `${NAME}.app`); fs.renameSync(path.join(d, 'Electron.app'), app);
      const R = path.join(app, 'Contents/Resources'); fs.rmSync(path.join(R, 'default_app.asar'), { force: true });
      fs.copyFileSync(asarFile, path.join(R, 'app.asar')); fs.copyFileSync(path.join(parts, 'icon.icns'), path.join(R, 'electron.icns'));
      // Info.plist: name, id, version and the asar integrity hash (edited as text: plutil only exists on macOS).
      const P = path.join(app, 'Contents/Info.plist'); let t = fs.readFileSync(P, 'utf8');
      const setKey = (k, v) => { const re = new RegExp(`(<key>${k}</key>\\s*<string>)[^<]*(</string>)`); t = re.test(t) ? t.replace(re, `$1${v}$2`) : t.replace('</dict>\n</plist>', `\t<key>${k}</key>\n\t<string>${v}</string>\n</dict>\n</plist>`); };
      setKey('CFBundleName', NAME); setKey('CFBundleDisplayName', NAME); setKey('CFBundleIdentifier', 'com.parano1dworld.wallet'); setKey('CFBundleShortVersionString', version);
      t = t.replace(/\t<key>ElectronAsarIntegrity<\/key>[\s\S]*?<\/dict>\n\t<\/dict>\n/, '');
      t = t.replace('</dict>\n</plist>', `\t<key>ElectronAsarIntegrity</key>\n\t<dict>\n\t\t<key>Resources/app.asar</key>\n\t\t<dict>\n\t\t\t<key>algorithm</key>\n\t\t\t<string>SHA256</string>\n\t\t\t<key>hash</key>\n\t\t\t<string>${headerSha}</string>\n\t\t</dict>\n\t</dict>\n</dict>\n</plist>`);
      fs.writeFileSync(P, t);
      flipFuses(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'), true);
      execFileSync('zip', ['-q', '-r', '-y', '-X', path.join(out, `Parano1d-World-Wallet-${version}-mac-${arch}.zip`), `${NAME}.app`], { cwd: d });
    } else {
      fs.rmSync(path.join(d, 'resources/default_app.asar'), { force: true }); fs.copyFileSync(asarFile, path.join(d, 'resources/app.asar'));
      const exe = os === 'win32' ? `${NAME}.exe` : 'parano1d-world-wallet';
      fs.renameSync(path.join(d, os === 'win32' ? 'electron.exe' : 'electron'), path.join(d, exe));
      flipFuses(path.join(d, exe), false);
      if (os === 'win32') { fs.copyFileSync(path.join(root, 'desktop/installers/Uninstall.ps1'), path.join(d, 'Uninstall.ps1'));
        execFileSync('zip', ['-q', '-r', '-X', path.join(out, `Parano1d-World-Wallet-${version}-windows-${arch}.zip`), '.'], { cwd: d }); }
      else { fs.copyFileSync(path.join(parts, 'icon.png'), path.join(d, 'icon.png'));
        execFileSync('tar', ['-czf', path.join(out, `parano1d-world-wallet-${version}-linux-${arch}.tar.gz`), '--owner=0', '--group=0', '-C', d, '.']); }
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
  writeSums(out); fs.rmSync(work, { recursive: true, force: true });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (opt('--sums')) console.log(`SHA256SUMS: ${writeSums(opt('--sums'))} files`);
  else build({ only: opt('--only')?.split(','), cache: opt('--electron-cache') }).then(o => console.log('release files in', o));
}
