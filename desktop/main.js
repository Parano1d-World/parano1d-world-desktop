// Parano1d World Desktop Wallet. Locked down: the wallet code ships inside this app (nothing is loaded from the
// internet as code), runs in a sandboxed renderer with no Node access, and can only talk to parano1dworld.com's
// /api/ routes through this process. Keys are created, encrypted and used only inside the window, as on the website.
'use strict';
const { app, BrowserWindow, protocol, session, shell, net, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCHEME = 'p1w', HOST = 'wallet', ORIGIN = `${SCHEME}://${HOST}`;
const CONFIG = require('./config.json'), SITE = CONFIG.site; // https://parano1dworld.com (fixed at build time)
const BUILD = String(CONFIG.build || ''); // content id of the bundled site, compared with the published one
const PARTITION = 'persist:p1w-wallet';
const ROOT = path.join(__dirname, 'site');
const API_PREFIXES = ['/api/'];
const MAX_BODY = 4_400_000;
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'self'; manifest-src 'self'; media-src 'none'; require-trusted-types-for 'script'; trusted-types parano1d-html parano1d-engine";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };

// Hardening before anything starts.
app.enableSandbox();
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
// Installed builds refuse debugging switches (and their fuses also block --inspect); only an unpackaged dev run may be driven by tests.
if (app.isPackaged) for (const sw of ['remote-debugging-port', 'remote-debugging-address', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags']) if (app.commandLine.hasSwitch(sw)) app.exit(1);
if (!app.requestSingleInstanceLock()) app.quit();
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true } }]);

const secure = h => ({ 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=()', ...h });

async function serve(req) {
  const u = new URL(req.url);
  if (u.host !== HOST) return new Response('Not found', { status: 404 });
  if (API_PREFIXES.some(p => u.pathname.startsWith(p))) return proxy(req, u);
  if (u.pathname.startsWith('/local/verifier/')) return verifierRoute(req, u);
  if (u.pathname === '/downloads/manifest.json' && req.method === 'GET') return liveManifestRoute();
  if (u.pathname.startsWith('/downloads/')) return new Response('Not found', { status: 404 });
  if (u.pathname === '/local/rigkit' && req.method === 'POST') return rigKitRoute();
  if (u.pathname === '/local/update' && req.method === 'GET') return updateRoute();
  if (u.pathname.startsWith('/local/mining/')) return localMining(req, u);
  if (u.pathname === '/local/uninstall' && req.method === 'POST') return uninstallRoute(req);
  let rel = decodeURIComponent(u.pathname); if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
  let body; try { body = await fs.promises.readFile(file); } catch { return new Response('Not found', { status: 404, headers: secure({ 'content-type': 'text/plain' }) }); }
  return new Response(body, { status: 200, headers: secure({ 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' }) });
}

// The only network access: the same /api/ routes the website uses, on parano1dworld.com, over HTTPS.
async function proxy(req, u) {
  if (!['GET', 'POST'].includes(req.method)) return new Response('{"ok":false,"error":"Method not allowed"}', { status: 405 });
  const headers = { accept: 'application/json', 'x-p1w-client': 'parano1d-world-desktop' };
  for (const h of ['content-type', 'x-paramo1d-time', 'x-paramo1d-signature']) { const v = req.headers.get(h); if (v) headers[h] = v; }
  let body;
  if (req.method === 'POST') { const buf = Buffer.from(await req.arrayBuffer()); if (buf.length > MAX_BODY) return new Response('{"ok":false,"error":"Too large"}', { status: 413 }); body = buf; }
  try {
    const r = await net.fetch(SITE + u.pathname + u.search, { method: req.method, headers, body, redirect: 'error', bypassCustomProtocolHandlers: true, credentials: 'omit', cache: 'no-store' });
    const out = Buffer.from(await r.arrayBuffer());
    return new Response(out, { status: r.status, headers: secure({ 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' }) });
  } catch { return new Response('{"ok":false,"error":"Parano1d World is unreachable. Check your internet connection."}', { status: 503, headers: { 'content-type': 'application/json' } }); }
}

// ---- On-device verifier (optional): the same native Parano1d node program the phones use (paramo1d), shipped next
// to the app with its pinned mainnet verification parameters. It talks to mainnet peers directly, checks headers,
// the recursive State proof and receipts itself, and never signs or sends anything ("api" allows read-only ops).
// The window reaches it only through p1w://wallet/local/verifier/*; one job runs at a time.
const VERIFIER_DIR = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'verifier');
const VERIFIER_BIN = path.join(VERIFIER_DIR, process.platform === 'win32' ? 'paramo1d.exe' : 'paramo1d');
const VERIFIER_ARTIFACTS = path.join(VERIFIER_DIR, 'artifacts');
const verifierData = () => path.join(app.getPath('userData'), 'verifier-data');
const verifierAvailable = () => { try { return fs.statSync(VERIFIER_BIN).isFile() && fs.statSync(VERIFIER_ARTIFACTS).isDirectory(); } catch { return false; } };
let verifierBusy = null;
function runVerifier(request, timeoutMs) {
  if (verifierBusy) return verifierBusy.then(() => runVerifier(request, timeoutMs), () => runVerifier(request, timeoutMs));
  const job = new Promise((resolve, reject) => {
    fs.mkdirSync(verifierData(), { recursive: true });
    const child = spawn(VERIFIER_BIN, ['api'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', RUST_BACKTRACE: '0' } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('The on-device check took too long and was stopped.')); }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 8_000_000) out += d; });
    child.stderr.on('data', d => { if (err.length < 20_000) err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer);
      if (code !== 0) { const line = err.split('\n').find(l => l.startsWith('Error:')) || 'Error: The on-device verifier failed'; return reject(new Error(line.replace(/^Error:\s*/, '').slice(0, 240))); }
      try { resolve(JSON.parse(out)); } catch { reject(new Error('The on-device verifier returned unreadable output.')); } });
    child.stdin.end(JSON.stringify({ ...request, artifacts: VERIFIER_ARTIFACTS, data_dir: verifierData() }));
  });
  verifierBusy = job.finally(() => { verifierBusy = null; });
  return job;
}
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: secure({ 'content-type': 'application/json', 'cache-control': 'no-store' }) });
async function verifierRoute(req, u) {
  const what = u.pathname.slice('/local/verifier/'.length);
  if (req.method !== 'GET' && !(req.method === 'POST' && what === 'send')) return jsonRes({ ok: false, error: 'Method not allowed' }, 405);
  if (what === 'status') {
    let accepted = null; try { accepted = JSON.parse(fs.readFileSync(path.join(verifierData(), 'accepted.json'), 'utf8')); } catch {}
    return jsonRes({ ok: true, available: verifierAvailable(), busy: Boolean(verifierBusy), accepted: accepted && Number.isSafeInteger(accepted.height) ? { height: accepted.height } : null });
  }
  if (!verifierAvailable()) return jsonRes({ ok: false, error: 'The on-device verifier is not installed in this build.' }, 404);
  try {
    if (what === 'sync') return jsonRes({ ok: true, result: await runVerifier({ op: 'sync_once' }, 25 * 60_000) });
    if (what === 'tx') {
      const id = u.searchParams.get('id') || ''; if (!/^[0-9a-f]{64}$/.test(id)) return jsonRes({ ok: false, error: 'Invalid transaction ID' }, 400);
      await runVerifier({ op: 'sync_once' }, 25 * 60_000);
      const found = await runVerifier({ op: 'transaction_status', txid: id, paranoid_mode: true }, 5 * 60_000);
      if (!found || typeof found.receipt_hex !== 'string') return jsonRes({ ok: true, result: { stage: found?.stage || 'unknown', verified: false } });
      const checked = await runVerifier({ op: 'receipt_check', receipt_hex: found.receipt_hex, expected_txid: id }, 10 * 60_000);
      return jsonRes({ ok: true, result: { stage: 'included', verified: true, receipt: checked } });
    }
    if (what === 'balance') {
      const a = (u.searchParams.get('address') || '').toLowerCase(); if (!/^o1[a-z0-9]{20,140}$/.test(a)) return jsonRes({ ok: false, error: 'Invalid address' }, 400);
      await runVerifier({ op: 'sync_once' }, 25 * 60_000);
      return jsonRes({ ok: true, result: await runVerifier({ op: 'peer_wallet_probe', address: a, paranoid_mode: true }, 5 * 60_000) });
    }
    // This computer as its own node (like the phones): the payment's coins, empty slots, epoch anchor and fees come
    // from the chain this app verified itself, straight from peers. Only the public address goes in; the wallet plans,
    // checks and signs in the window, and the signed payment goes out to peers here.
    if (what === 'context') {
      const a = (u.searchParams.get('address') || '').toLowerCase(); if (!/^o1[a-z0-9]{20,140}$/.test(a)) return jsonRes({ ok: false, error: 'Invalid address' }, 400);
      await runVerifier({ op: 'sync_once' }, 25 * 60_000);
      return jsonRes({ ok: true, result: await runVerifier({ op: 'payment_context', address: a, paranoid_mode: true }, 5 * 60_000) });
    }
    if (what === 'send') {
      const body = Buffer.from(await req.arrayBuffer()); if (body.length > 9 * 1024 * 1024) return jsonRes({ ok: false, error: 'Payment too large' }, 413);
      let b; try { b = JSON.parse(body.toString('utf8')); } catch { return jsonRes({ ok: false, error: 'Invalid request' }, 400); }
      const h = String(b?.intent_hex || '').toLowerCase(), id = String(b?.txid || '');
      if (!/^(?:[0-9a-f]{2})+$/.test(h) || !/^[0-9a-f]{64}$/.test(id)) return jsonRes({ ok: false, error: 'Invalid payment' }, 400);
      return jsonRes({ ok: true, result: await runVerifier({ op: 'broadcast_send', intent_hex: h, txid: id, paranoid_mode: true }, 3 * 60_000) });
    }
    return jsonRes({ ok: false, error: 'Not found' }, 404);
  } catch (e) { return jsonRes({ ok: false, error: String(e.message || e).slice(0, 240) }, 502); }
}

// Links leave the app only to the default browser: any https page, plus exactly one local address, the mining
// dashboard on this computer (local-ports.js: it only answers on this machine and needs its access code).
const { DASHBOARD, DASHBOARD_HOST, DASHBOARD_PORT } = require('./local-ports.js');
let siteWindows = null; // partner sites (Noidium) open in the app's own window, where this wallet is offered to them
function openExternal(url) {
  try {
    if (siteWindows && siteWindows.allowedOrigin(url)) return void siteWindows.open(url);
    const u = new URL(url);
    if (u.protocol === 'https:') return void shell.openExternal(u.toString());
    if (u.protocol === 'http:' && u.host === `${DASHBOARD_HOST}:${DASHBOARD_PORT}` && u.pathname === '/' && !u.username && !u.password && !u.search) shell.openExternal(DASHBOARD + '/' + u.hash);
  } catch {}
}

// ---- Downloads, always the current published files ---------------------------------------------------------------
// The window still can't download anything. The app's own code fetches two things from parano1dworld.com, live
// (never a bundled copy, so they are always the latest): the download list with its SHA-256 fingerprints, and the
// mining rig kit. The kit is saved to the Downloads folder only if its size and SHA-256 match the live list.
const RIG_KIT = 'parano1d-world-rig-kit.zip', KIT_MAX = 25 * 1024 * 1024, HEX64 = /^[0-9a-f]{64}$/;
const fetchSite = async (p, accept) => { const r = await net.fetch(SITE + p, { headers: { accept, 'x-p1w-client': 'parano1d-world-desktop' }, redirect: 'error', bypassCustomProtocolHandlers: true, credentials: 'omit', cache: 'no-store' }); if (!r.ok) throw new Error('Parano1d World answered ' + r.status); return r; };
async function liveManifest() { const m = await (await fetchSite('/downloads/manifest.json', 'application/json')).json(); if (!m || typeof m.files !== 'object') throw new Error('The download list is unreadable'); return m; }
async function liveManifestRoute() {
  try { return jsonRes(await liveManifest()); } catch (e) { return jsonRes({ ok: false, error: 'The download list could not be loaded. Check your internet connection.' }, 503); }
}
let kitBusy = false;
async function rigKitRoute() {
  if (kitBusy) return jsonRes({ ok: false, error: 'The rig kit is already downloading.' }, 409);
  kitBusy = true;
  try {
    const k = (await liveManifest()).files?.[RIG_KIT];
    if (!k || !HEX64.test(k.sha256 || '') || !Number.isSafeInteger(k.bytes) || k.bytes <= 0 || k.bytes > KIT_MAX) return jsonRes({ ok: false, error: 'The published fingerprint for the rig kit is missing, so nothing was downloaded.' }, 502);
    const buf = Buffer.from(await (await fetchSite('/downloads/' + RIG_KIT, 'application/zip')).arrayBuffer());
    const got = require('crypto').createHash('sha256').update(buf).digest('hex');
    if (buf.length !== k.bytes || got !== k.sha256) return jsonRes({ ok: false, error: 'The downloaded rig kit did not match its published SHA-256 fingerprint, so it was not saved. Try again later.' }, 502);
    const dir = app.getPath('downloads'); await fs.promises.mkdir(dir, { recursive: true });
    let name = RIG_KIT; for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `parano1d-world-rig-kit (${i}).zip`;
    const tmp = path.join(dir, `.${name}.${process.pid}.part`);
    await fs.promises.writeFile(tmp, buf, { flag: 'wx' }); await fs.promises.rename(tmp, path.join(dir, name));
    shell.showItemInFolder(path.join(dir, name));
    return jsonRes({ ok: true, name, folder: path.basename(dir), bytes: buf.length, sha256: got });
  } catch (e) { return jsonRes({ ok: false, error: 'The rig kit could not be downloaded. Check your internet connection and try again.' }, 503); }
  finally { kitBusy = false; }
}
// Install / Update Miner / remove mining on this computer (desktop/mining-local.js). The kit must carry the Parano1d
// World kit signature; its public key is fixed in config.json at build time.
const localMining = require('./mining-local.js')({ app, netFetch: (u, o) => net.fetch(u, o), appBuild: String(CONFIG.build || 'unknown'), fetchSite, liveManifest, jsonRes, publicKey: String(CONFIG.kitPublicKey || '') });
/** Is a newer Desktop Wallet published? Compares this app's bundled site with the published one (no auto-install). */
// Uninstall this app (owner rule 27 Nov: buttons, not Terminal commands). The page asks; the computer itself confirms in
// a native dialog the page cannot press. Wallet data is kept unless the user chose to erase it.
async function uninstallRoute(req) {
  let b = {}; try { b = JSON.parse(Buffer.from(await req.arrayBuffer()).toString('utf8') || '{}'); } catch {}
  const removeData = b.removeData === true, data = app.getPath('userData');
  const r = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || undefined, { type: 'warning', buttons: ['Cancel', 'Uninstall'], defaultId: 0, cancelId: 0, noLink: true,
    title: 'Uninstall Parano1d World Wallet', message: 'Remove Parano1d World Wallet from this computer?',
    detail: removeData ? 'Your encrypted wallet data on this computer will ALSO be deleted. Continue only if your master key is backed up.' : 'Your encrypted wallet data is kept, so reinstalling opens it again.' });
  if (r.response !== 1) return jsonRes({ ok: false, cancelled: true });
  if (!app.isPackaged) return jsonRes({ ok: false, error: 'This copy is not installed.' });
  const os = require('os'), q = t => "'" + String(t).replace(/'/g, "'\\''") + "'";
  try {
    if (process.platform === 'win32') {
      const script = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Parano1dWorldWallet', 'Uninstall.ps1');
      if (!fs.existsSync(script)) return jsonRes({ ok: false, error: 'Use Windows Settings › Apps › Installed apps › Parano1d World Wallet › Uninstall.' });
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', `Start-Sleep 2; & '${script.replace(/'/g, "''")}'${removeData ? ' -RemoveWalletData' : ''}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      let targets;
      if (process.platform === 'darwin') { const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//); if (!m) return jsonRes({ ok: false, error: 'Drag Parano1d World Wallet from Applications to the Trash.' }); targets = [m[1]]; }
      else if (process.execPath.startsWith('/opt/parano1d-world-wallet/')) {
        // Installed from the .deb: the system removes it after asking for the computer's own password (polkit).
        if (!fs.existsSync('/usr/bin/pkexec')) return jsonRes({ ok: false, error: 'Remove Parano1d World Wallet with your software app (or: sudo apt remove parano1d-world-wallet).' });
        spawn('/bin/sh', ['-c', `sleep 2; /usr/bin/pkexec /usr/bin/dpkg -r parano1d-world-wallet${removeData ? ' && rm -rf ' + q(data) : ''}`], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => app.quit(), 700); return jsonRes({ ok: true });
      }
      else { const h = os.homedir(), opt = path.join(h, '.local/opt/parano1d-world-wallet'); if (!process.execPath.startsWith(opt + path.sep)) return jsonRes({ ok: false, error: 'This copy was installed another way; remove it with your system\u2019s app manager.' });
        targets = [opt, path.join(h, '.local/share/applications/parano1d-world-wallet.desktop'), path.join(h, '.local/bin/parano1d-world-wallet')]; }
      if (removeData) targets.push(data);
      spawn('/bin/sh', ['-c', `sleep 2; rm -rf ${targets.map(q).join(' ')}`], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) { return jsonRes({ ok: false, error: 'The uninstaller could not start.' }); }
  setTimeout(() => app.quit(), 700); return jsonRes({ ok: true });
}
async function updateRoute() {
  try { const v = await (await fetchSite('/downloads/desktop/version.json', 'application/json')).json(); const latest = String(v?.build || ''); return jsonRes({ ok: true, current: BUILD, latest, version: String(v?.version || ''), available: !!(BUILD && latest && latest !== BUILD) }); }
  catch { return jsonRes({ ok: false, available: false }); }
}

function createWindow() {
  const ses = session.fromPartition(PARTITION);
  const win = new BrowserWindow({
    width: 1320, height: 900, minWidth: 380, minHeight: 600, show: false, backgroundColor: '#050a07', title: 'Parano1d World Wallet', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false,
      experimentalFeatures: false, webviewTag: false, spellcheck: false, devTools: !app.isPackaged && process.env.P1W_DEVTOOLS === '1', navigateOnDragDrop: false, safeDialogs: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) { e.preventDefault(); openExternal(url); } });
  win.webContents.on('will-redirect', (e, url) => { if (!url.startsWith(ORIGIN + '/')) e.preventDefault(); });
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.webContents.on('before-input-event', (e, i) => { if ((i.control || i.meta) && i.shift && ['i', 'j', 'c'].includes(i.key.toLowerCase())) e.preventDefault(); if (i.key === 'F12') e.preventDefault(); });
  win.once('ready-to-show', () => win.show());
  win.loadURL(ORIGIN + '/index.html#Wallet');
  return win;
}

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', e => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
});

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  ses.protocol.handle(SCHEME, serve);
  // Nothing in the window may reach the network directly: only p1w:// (served above), data: images and devtools-free.
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(ORIGIN + '/') || d.url.startsWith('data:') || d.url.startsWith('blob:' + ORIGIN)) }));
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'clipboard-read'].includes(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => ['clipboard-sanitized-write', 'clipboard-read'].includes(perm));
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', e => e.preventDefault());
  ses.setSpellCheckerEnabled?.(false);
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  siteWindows = require('./site-window.js')({ app, ORIGIN, PARTITION, openExternal });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
