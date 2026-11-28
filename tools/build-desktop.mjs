// Builds the Parano1d World Desktop Wallet downloads from release/ (the same stripped, tested site):
//   deploy/downloads/desktop/{app.asar, icon.png, icon.icns, install.sh, Parano1d-World-Wallet-Windows.zip, version.json}
// The Electron runtime itself is not hosted here: installers fetch the official build from GitHub and check the
// SHA-256 values pinned below (copied from Electron's SHASUMS256.txt for this version).
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const req = createRequire(path.join(root, 'tools/desktop-deps/package.json'));
const asar = req('@electron/asar');
const ELECTRON = '45.4.1', APP_VERSION = '1.0.0', SITE = process.env.P1W_DESKTOP_SITE || 'https://parano1dworld.com';
const PINS = { SHA_WIN_X64: '2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9', SHA_WIN_ARM64: '5ad2f09093cba71ad7dc8ddb2ef7261978c9130aa07e492556efe802f6ca74e9',
  SHA_MAC_ARM64: 'd080c3b05a01bd16137f2c12ab9ebf083c577757fe846844ba325bafa8e8bdf4', SHA_MAC_X64: '1c80d2ccf71b02c8fd9940fd09cafe88090a48c1bab0193c79b597b08d890e79',
  SHA_LINUX_X64: 'e1d077c7a087d7e344350ea0c5cd2b7dc5af3d9bf7979474f38e0fc1a560b875', SHA_LINUX_ARM64: '3da04c450fa682e3b80961e92a918a1c2a1a10796527a7e63dec7b8e466b6334' };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
export async function buildDesktop({ release = path.join(root, 'release'), out = path.join(root, 'release/downloads/desktop'), site = SITE } = {}) {
  const stage = fs.mkdtempSync('/tmp/p1w-desktop-'), app = path.join(stage, 'app');
  fs.mkdirSync(path.join(app, 'site'), { recursive: true });
  const skip = new Set(['downloads', '_worker.js', '_headers', '_routes.json', 'robots.txt', 'sitemap.xml', 'RELEASE-MANIFEST.json']);
  for (const e of fs.readdirSync(release)) if (!skip.has(e)) fs.cpSync(path.join(release, e), path.join(app, 'site', e), { recursive: true });
  fs.rmSync(path.join(app, 'site', 'merch', 'files'), { recursive: true, force: true }); // print files are for the printer only (40 MB); the app shows previews
  for (const f of ['boot.js', 'main.js', 'package.json', 'mining-local.js', 'mining-service.js', 'mining-paths.js', 'local-ports.js', 'site-window.js', 'site-preload.js', 'approve-preload.js']) fs.copyFileSync(path.join(root, 'desktop', f), path.join(app, f));
  fs.copyFileSync(path.join(root, 'rig-companion', 'kit-verify.mjs'), path.join(app, 'kit-verify.mjs'));
  // The mining dashboard the Mac/Linux background service runs (mining-service.js), covered by the app.asar pin.
  fs.mkdirSync(path.join(app, 'rig-companion'), { recursive: true });
  for (const f of ['agent.mjs', 'remote.mjs', 'telemetry.mjs', 'miner-install.mjs', 'hardware.mjs', 'kit-verify.mjs', 'kit-public-key.pem', 'dashboard.html', 'dashboard.js', 'dashboard.css', 'qr.js', 'mining-emblem-128.png', 'mining-wordmark.webp', 'favicon.ico']) fs.copyFileSync(path.join(root, 'rig-companion', f), path.join(app, 'rig-companion', f));
  // Build id = fingerprint of the bundled site files; the app compares it with the published version.json to say
  // when an update is available.
  const walkAll = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkAll(path.join(d, e.name)) : [path.join(d, e.name)]);
  const siteDir = path.join(app, 'site'), idHash = crypto.createHash('sha256');
  for (const f of walkAll(app).sort()) idHash.update(path.relative(app, f) + '\0').update(fs.readFileSync(f)); // site + app code + dashboard
  const BUILD = idHash.digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ site, version: APP_VERSION, build: BUILD, kitPublicKey: fs.readFileSync(path.join(root, 'rig-companion', 'kit-public-key.pem'), 'utf8') }));
  fs.copyFileSync(path.join(root, 'deploy/brand/icon-512.png'), path.join(app, 'icon.png'));
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const asarFile = path.join(out, 'app.asar');
  await asar.createPackage(app, asarFile);
  const headerSha = crypto.createHash('sha256').update(asar.getRawHeader(asarFile).headerString).digest('hex');
  fs.copyFileSync(path.join(root, 'deploy/brand/icon-512.png'), path.join(out, 'icon.png'));
  execFileSync('python3', ['-c', `from PIL import Image; im=Image.open('${path.join(root, 'deploy/brand/icon-512.png')}').convert('RGBA'); im.save('${path.join(stage, 'icon.ico')}', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]); im.resize((1024,1024)).save('${path.join(out, 'icon.icns')}')`]);
  const vars = { ...PINS, ELECTRON_VERSION: ELECTRON, APP_VERSION, SITE: site, APP_ASAR_SHA: sha(asarFile), ASAR_HEADER_SHA: headerSha, ICON_SHA: sha(path.join(out, 'icon.png')), ICNS_SHA: sha(path.join(out, 'icon.icns')) };
  const fill = t => t.replace(/__([A-Z0-9_]+)__/g, (m, k) => { if (!(k in vars)) throw new Error('unfilled ' + m); return vars[k]; });
  const inst = path.join(root, 'desktop/installers');
  fs.writeFileSync(path.join(out, 'install.sh'), fill(fs.readFileSync(path.join(inst, 'install.sh'), 'utf8')), { mode: 0o755 });
  // Linux one-click (.deb, owner 27 Nov: "buttons, not prompts"): double-click it, press Install in the software app.
  // It carries the checked app.asar; its postinst fetches the pinned Electron runtime (too big to host here) as root.
  { const deb = path.join(stage, 'deb'), dsrc = path.join(inst, 'deb'), shTxt = fs.readFileSync(path.join(inst, 'install.sh'), 'utf8');
    const fz = shTxt.slice(shTxt.indexOf('fuses() { perl'), shTxt.indexOf("Nothing was installed.'; }", shTxt.indexOf('fuses() { perl')) + "Nothing was installed.'; }".length);
    if (!fz.startsWith('fuses() {') || !fz.includes('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')) throw new Error('fuse code not found in install.sh');
    const stamp = process.env.P1W_DEB_STAMP || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const dv = { ...vars, DEB_VERSION: `${APP_VERSION}+${stamp}` }, fillD = t => t.replace(/__([A-Z0-9_]+)__/g, (m, k) => { if (!(k in dv)) throw new Error('unfilled ' + m); return dv[k]; });
    const lib = path.join(deb, 'usr/lib/parano1d-world-wallet'), ctl = path.join(deb, 'DEBIAN'), apps = path.join(deb, 'usr/share/applications'), bin = path.join(deb, 'usr/bin');
    for (const d of [lib, ctl, apps, bin]) fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    fs.copyFileSync(asarFile, path.join(lib, 'app.asar')); fs.copyFileSync(path.join(root, 'deploy/brand/icon-512.png'), path.join(lib, 'icon.png'));
    fs.writeFileSync(path.join(lib, 'setup-runtime.sh'), fillD(fs.readFileSync(path.join(dsrc, 'setup-runtime.sh'), 'utf8').replace('__FUSES__', () => fz)), { mode: 0o755 });
    fs.copyFileSync(path.join(dsrc, 'parano1d-world-wallet.desktop'), path.join(apps, 'parano1d-world-wallet.desktop'));
    fs.symlinkSync('/opt/parano1d-world-wallet/parano1d-world-wallet', path.join(bin, 'parano1d-world-wallet'));
    fs.writeFileSync(path.join(ctl, 'control'), fillD(fs.readFileSync(path.join(dsrc, 'control'), 'utf8')));
    for (const f of ['postinst', 'prerm', 'postrm']) fs.writeFileSync(path.join(ctl, f), fs.readFileSync(path.join(dsrc, f), 'utf8'), { mode: 0o755 });
    for (const f of [path.join(lib, 'app.asar'), path.join(lib, 'icon.png'), path.join(apps, 'parano1d-world-wallet.desktop'), path.join(ctl, 'control')]) fs.chmodSync(f, 0o644);
    execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', deb, path.join(out, 'Parano1d-World-Wallet-Linux.deb')], { stdio: 'pipe' }); }
  const win = path.join(stage, 'Parano1d-World-Wallet-Windows'); fs.mkdirSync(win);
  fs.writeFileSync(path.join(win, 'Install.ps1'), fill(fs.readFileSync(path.join(inst, 'Install.ps1'), 'utf8')).replace(/\r?\n/g, '\r\n'));
  fs.writeFileSync(path.join(win, 'Uninstall.ps1'), fs.readFileSync(path.join(inst, 'Uninstall.ps1'), 'utf8').replace(/\r?\n/g, '\r\n'));
  fs.copyFileSync(path.join(inst, 'Install.cmd'), path.join(win, 'Install.cmd'));
  fs.copyFileSync(asarFile, path.join(win, 'app.asar')); fs.copyFileSync(path.join(stage, 'icon.ico'), path.join(win, 'icon.ico'));
  fs.writeFileSync(path.join(win, 'READ ME.txt'), `Parano1d World Desktop Wallet ${APP_VERSION}\r\n\r\n1. Extract this whole folder.\r\n2. Double-click Install.cmd.\r\n\r\nIt downloads the official Electron ${ELECTRON} runtime from GitHub, checks its SHA-256, adds the wallet app (checked too) and creates Start menu and Desktop shortcuts. To update, download and run the newest installer: your wallet data is kept. Uninstall from Settings > Apps.\r\n`);
  const zip = path.join(out, 'Parano1d-World-Wallet-Windows.zip');
  execFileSync('zip', ['-q', '-r', '-X', zip, 'Parano1d-World-Wallet-Windows'], { cwd: stage });
  // SHA256SUMS (the format sha256sum -c / shasum -a 256 -c read) and the checksums shown on the download page.
  // Signed + notarized Mac disk images (desktop/release/sign-mac.sh, run on the Mac) are published when present in
  // desktop/release/signed/: one per chip, renamed to fixed download names. Without them the page offers the Terminal install.
  const MAC_DMG = { 'mac-arm64': 'Parano1d-World-Wallet-Mac-AppleSilicon.dmg', 'mac-x64': 'Parano1d-World-Wallet-Mac-Intel.dmg' };
  const signedDir = path.join(root, 'desktop', 'release', 'signed'), macFiles = [];
  for (const [k, name] of Object.entries(MAC_DMG)) {
    const src = fs.existsSync(signedDir) ? fs.readdirSync(signedDir).find(f => f.endsWith(`-${k}.dmg`)) : null;
    if (src && fs.statSync(path.join(signedDir, src)).size > 1e6) { fs.copyFileSync(path.join(signedDir, src), path.join(out, name)); macFiles.push(name); }
  }
  const listed = ['Parano1d-World-Wallet-Windows.zip', 'Parano1d-World-Wallet-Linux.deb', 'install.sh', 'app.asar', 'icon.png', 'icon.icns', ...macFiles];
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), listed.map(f => `${sha(path.join(out, f))}  ${f}`).join('\n') + '\n');
  { const page = path.join(path.dirname(path.dirname(out)), 'desktop-wallet.html');
    if (fs.existsSync(page)) { const t = fs.readFileSync(page, 'utf8').split('__SHA_INSTALL_SH__').join(sha(path.join(out, 'install.sh'))).split('__SHA_WIN_ZIP_UPPER__').join(sha(path.join(out, 'Parano1d-World-Wallet-Windows.zip')).toUpperCase()).split('__SHA_LINUX_DEB__').join(sha(path.join(out, 'Parano1d-World-Wallet-Linux.deb'))); fs.writeFileSync(page, t); } }
  fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version: APP_VERSION, build: BUILD, electron: ELECTRON, files: Object.fromEntries(['app.asar', 'install.sh', 'Parano1d-World-Wallet-Windows.zip', 'Parano1d-World-Wallet-Linux.deb', 'icon.png', 'icon.icns', ...macFiles, 'SHA256SUMS'].map(f => [f, { sha256: sha(path.join(out, f)), bytes: fs.statSync(path.join(out, f)).size }])) }, null, 1));
  fs.rmSync(stage, { recursive: true, force: true });
  return vars;
}
if (import.meta.url === `file://${process.argv[1]}`) buildDesktop().then(v => console.log('desktop wallet built', v.APP_ASAR_SHA));
