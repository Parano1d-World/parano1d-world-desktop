// Desktop Wallet end to end (Linux, Xvfb): the real app code (desktop/main.js + the release site) in the official
// Electron runtime, against the mock node stack. Checks: it loads from the bundled files, all data goes through the
// /api proxy, the renderer cannot reach the internet directly, and a wallet can be created and SEND a payment
// (planned by the node, signed in the window, accepted by the node after it verifies the authorization).
// Then the installed form: fuses flipped by the installer's own code, and the packaged app starts and stays up.
import { spawn, execFileSync } from 'node:child_process'; import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const req = createRequire(path.join(root, 'tools/desktop-deps/package.json'));
const { DASHBOARD } = createRequire(import.meta.url)('../desktop/local-ports.js'); // the one local address the app may open
const { _electron } = req('playwright-core'); const fuses = req('@electron/fuses'); const asar = req('@electron/asar');
const ZIP = process.env.P1W_ELECTRON_LINUX_ZIP || '/tmp/el/electron-linux.zip', PORT = 8831, SITE = `http://127.0.0.1:${PORT}`;
if (!fs.existsSync(ZIP)) { fs.mkdirSync(path.dirname(ZIP), { recursive: true }); execFileSync('curl', ['-fsSL', '-o', ZIP, 'https://github.com/electron/electron/releases/download/v45.4.1/electron-v45.4.1-linux-x64.zip']); }
if (execFileSync('sha256sum', [ZIP]).toString().slice(0, 64) !== 'e1d077c7a087d7e344350ea0c5cd2b7dc5af3d9bf7979474f38e0fc1a560b875') { console.log('FAIL Electron runtime checksum'); process.exit(1); }
let xvfb = null; if (!process.env.DISPLAY) { xvfb = spawn('Xvfb', [':57', '-ac', '-screen', '0', '1400x1000x24'], { stdio: 'ignore' }); process.env.DISPLAY = ':57'; await new Promise(r => setTimeout(r, 800)); }
const results = []; const check = (n, c) => { results.push(!!c); console.log((c ? 'ok   ' : 'FAIL ') + n); return !!c; };
const W = fs.mkdtempSync('/tmp/p1w-desk-e2e-'); fs.chmodSync(W, 0o755);
// Chromium refuses to run as root with its sandbox on (and we keep the sandbox on), so the app runs as an ordinary user,
// with chrome-sandbox set up the way the Linux installer sets it up when user namespaces are unavailable.
const USER = process.env.P1W_TEST_USER || 'ubuntu', HOME = path.join(W, 'home');
const asUser = dir => { const f = path.join(dir, 'run-as-user.sh'); fs.writeFileSync(f, `#!/bin/sh\nexec setpriv --reuid=${USER} --regid=${USER} --init-groups env HOME=${HOME} DISPLAY=\"$DISPLAY\" \"$(dirname \"$0\")/$P1W_BIN\" \"$@\"\n`, { mode: 0o755 }); return f; };
const prepRuntime = dir => { execFileSync('chmod', ['-R', 'a+rX', dir]); const sb = path.join(dir, 'chrome-sandbox'); fs.chownSync(sb, 0, 0); fs.chmodSync(sb, 0o4755); };
const srv = spawn('node', [path.join(root, 'tools/dev-server.mjs'), String(PORT), '--mock', ...(process.env.P1W_DEPLOY_DIR ? [] : [])], { stdio: 'ignore', env: { ...process.env, P1W_DEPLOY_DIR: path.join(root, 'release'), P1W_DEV_INFO: path.join(W, 'dev.json') } });
const until = async (f, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await f()) return true; } catch {} await new Promise(r => setTimeout(r, 200)); } return false; };
try {
  await until(async () => (await fetch(SITE + '/')).ok, 60000);
  // App folder exactly as the build makes it, but pointed at the mock site.
  const app = path.join(W, 'app'); fs.mkdirSync(path.join(app, 'site'), { recursive: true });
  for (const e of fs.readdirSync(path.join(root, 'release'))) if (!['downloads', '_worker.js', '_headers'].includes(e)) fs.cpSync(path.join(root, 'release', e), path.join(app, 'site', e), { recursive: true });
  for (const f of ['boot.js', 'main.js', 'package.json', 'mining-local.js', 'mining-service.js', 'mining-paths.js', 'local-ports.js', 'site-window.js', 'site-preload.js', 'approve-preload.js']) fs.copyFileSync(path.join(root, 'desktop', f), path.join(app, f));
  fs.copyFileSync(path.join(root, 'rig-companion', 'kit-verify.mjs'), path.join(app, 'kit-verify.mjs'));
  // The mining dashboard the Mac/Linux background service runs (mining-service.js), covered by the app.asar pin.
  fs.mkdirSync(path.join(app, 'rig-companion'), { recursive: true });
  for (const f of ['agent.mjs', 'remote.mjs', 'telemetry.mjs', 'miner-install.mjs', 'hardware.mjs', 'kit-verify.mjs', 'kit-public-key.pem', 'dashboard.html', 'dashboard.js', 'dashboard.css', 'qr.js', 'mining-emblem-128.png', 'mining-wordmark.webp', 'favicon.ico']) fs.copyFileSync(path.join(root, 'rig-companion', f), path.join(app, 'rig-companion', f));
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ site: SITE, version: 'test', build: 'test-older-build', kitPublicKey: fs.readFileSync(path.join(root, 'rig-companion', 'kit-public-key.pem'), 'utf8') })); fs.copyFileSync(path.join(root, 'deploy/brand/icon-512.png'), path.join(app, 'icon.png'));
  execFileSync('unzip', ['-q', ZIP, '-d', path.join(W, 'rt')]); prepRuntime(path.join(W, 'rt'));
  fs.mkdirSync(HOME); execFileSync('chown', ['-R', USER, HOME]); execFileSync('chmod', ['-R', 'a+rX', app]);
  const ea = await _electron.launch({ executablePath: asUser(path.join(W, 'rt')), args: [app], env: { ...process.env, P1W_BIN: 'electron', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const pg = await ea.firstWindow(); const errs = []; globalThis.__pg = pg; const cons = []; globalThis.__cons = cons; pg.on('console', m => cons.push(m.type() + ': ' + m.text())); pg.on('pageerror', e => errs.push(String(e)));
  await pg.waitForSelector('#page', { timeout: 30000 });
  check('loads the bundled wallet from p1w://wallet (no remote code)', pg.url().startsWith('p1w://wallet/'));
  check('opens on the wallet setup (Create / Import)', await until(async () => await pg.locator('#vx-create').count() > 0));
  { await pg.goto('p1w://wallet/'); await pg.waitForSelector('#appear-home', { timeout: 20000 }); await pg.setViewportSize({ width: 400, height: 860 });
    let okAll = true; for (const look of ['light', 'dark', 'world']) { if (await pg.locator('#appear-menu-home').isHidden()) await pg.click('#appear-home'); await pg.click(`#appear-menu-home [data-look="${look}"]`); /* the menu stays open to try the next look */ await pg.waitForTimeout(200); okAll &&= (await pg.evaluate(() => document.documentElement.dataset.theme)) === look; }
    check('appearance menu works in a narrow window (above the logo)', okAll); await pg.setViewportSize({ width: 1200, height: 860 }); }
  check('renderer cannot reach the internet directly', await pg.evaluate(() => fetch('https://example.com/').then(() => false, () => true)));
  check('renderer has no Node.js', await pg.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'));
  check('on-device verifier route answers honestly when no verifier is bundled (never claims verified)', await pg.evaluate(() => fetch('/local/verifier/status').then(r => r.json()).then(j => j.ok === true && j.available === false)) && await pg.evaluate(() => fetch('/local/verifier/tx?id=' + 'a'.repeat(64)).then(r => r.status === 404)));
  check('desktop app hides website-only items (extension card, game link)', await pg.evaluate(() => { location.hash = '#Wallet'; return new Promise(r => setTimeout(() => r(!document.getElementById('vx-extension') && !document.querySelector('a[href="/desktop-wallet"]')), 600)); }));
  check('data comes through the /api proxy (explorer status)', await pg.evaluate(() => fetch('/api/explorer/status').then(r => r.ok)));
  // Wallet: create through the vault module, unlock, fund, send.
  await pg.evaluate(([pw, pin]) => { const u = performance.getEntriesByType('resource').map(e => e.name).find(n => n.split('?')[0].endsWith('/js/core/vault.js')) || '/js/core/vault.js';
    return import(u).then(V => V.wallets().then(ws => ws.length ? null : V.setup({ password: pw, pin, nickname: 'Main wallet' }))).then(() => true); }, ['violet harbor lantern 42', '480263']);
  await pg.evaluate(() => { location.hash = '#Wallet'; }); await pg.reload(); await pg.waitForSelector('.vx-card', { timeout: 20000 });
  if (await pg.locator('#vx-unlock-pw').count()) { await pg.fill('#vx-unlock-pw', 'violet harbor lantern 42'); await pg.click('#vx-unlock button[type=submit]'); await pg.waitForSelector('#vx-lock', { timeout: 20000 }); }
  check('wallet created and unlocked in the desktop app', true);
  const addr = (await pg.innerText('.vx-card .vx-addr')).trim();
  // Partner site window (Noidium, served by the test): the wallet is offered through the shared standard, connect
  // goes through the app's own approval window, trade approvals are off until turned on, sign-in is not offered.
  { await ea.evaluate(({ session }) => { session.fromPartition('persist:p1w-site-noidium').protocol.handle('https', () => new Response('<!doctype html><title>Noidium test</title><p>Noidium', { headers: { 'content-type': 'text/html' } })); });
    const sitePromise = ea.waitForEvent('window', { timeout: 15000 });
    await pg.evaluate(() => { window.open('https://noidium.com/', '_blank'); });
    const site = await sitePromise; await site.waitForLoadState();
    const STD = `([m, p]) => new Promise(r => { window.addEventListener('parano1d:announceProvider', e => r(e.detail), { once: true }); window.dispatchEvent(new Event('parano1d:requestProvider')); }).then(d => d.provider.request({ method: m, params: p })).then(r => ({ r }), e => ({ code: e.code }))`;
    const info = await site.evaluate(() => new Promise(r => { window.addEventListener('parano1d:announceProvider', e => r({ name: e.detail.info.name, rdns: e.detail.info.rdns, frozen: Object.isFrozen(e.detail.provider) }), { once: true }); window.dispatchEvent(new Event('parano1d:requestProvider')); }));
    check('Noidium window: the app offers this wallet as "Parano1d World"', info.name === 'Parano1d World' && info.rdns === 'com.parano1dworld.wallet' && info.frozen);
    check('Noidium window: the site has no Node.js and cannot read the wallet', await site.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined' && !Object.keys(window).some(k => /vault|master/i.test(k))));
    check('Noidium window: no accounts before connecting; sign-in not offered (4200)', (await site.evaluate(eval(STD), ['accounts']))?.r?.length === 0 && (await site.evaluate(eval(STD), ['signIn', {}])).code === 4200);
    await site.evaluate(s => { window.__c = eval(s)(['connect']); }, STD);
    const ap = await until(async () => ea.windows().find(w => w.url().includes('/site-approve.html')), 15000) && ea.windows().find(w => w.url().includes('/site-approve.html'));
    await ap.waitForSelector('#cx-ok', { timeout: 15000 });
    check('Noidium window: connect opens the app’s own approval window with the real site', (await ap.innerText('#cx-host')) === 'noidium.com');
    await ap.click('#cx-ok');
    check('Noidium window: connect returns the chosen address', JSON.stringify((await site.evaluate('window.__c')).r) === JSON.stringify([addr]));
    await site.evaluate(s => { window.__t = eval(s)(['nativeRequest', { request: { action: 'buy_nft', collection_id: 'a'.repeat(64), serial: '1', maximum_ask_micronoid: '1000000' } }]); }, STD);
    await ap.waitForSelector('#cx-on', { timeout: 15000 });
    check('Noidium window: trade approvals are off for the site until turned on', (await ap.innerText('#cx')).includes('TRADE APPROVALS ARE OFF'));
    await ap.click('#cx-no');
    check('Noidium window: rejecting returns 4001; a hidden extra field is refused (-32602)', (await site.evaluate('window.__t')).code === 4001 && (await site.evaluate(eval(STD), ['nativeRequest', { request: { action: 'buy_nft', collection_id: 'a'.repeat(64), serial: '1', maximum_ask_micronoid: '1', recipient: addr } }])).code === -32602);
    await site.close(); }
  await fetch(`${SITE}/__test/fund?a=${addr}`);
  await pg.evaluate(() => { location.hash = '#Send'; }); await pg.waitForSelector('#send-form');
  await pg.fill('#send-to', 'o1d32rqvea37trluazs2w2f7gj92e00z48mcfnxs4gncp89t6w8wuqvqlx57'); await pg.fill('#send-amount', '1.5'); await pg.click('#send-form button[type=submit]');
  await pg.waitForSelector('#xc-ok', { timeout: 20000 }); await pg.check('#xc-ok'); await pg.click('#xc-go');
  await pg.waitForSelector('#pr-ok', { timeout: 30000 });
  check('payment review shows the node-planned fee', (await pg.textContent('#modal-root')).includes('0.009000 NOID'));
  await pg.click('#pr-ok'); await pg.waitForSelector('#vx-pin-form'); await pg.fill('#vx-pin', '480263'); await pg.click('#vx-pin-form button[type=submit]');
  check('signed in the desktop app and accepted by the node', await until(async () => (await pg.textContent('#modal-root')).includes('sent to the network'), 150000));
  check('other features work: Explorer, Chat, Mining pages render', await (async () => { for (const r of ['Explorer', 'Chat', 'Mining', 'NFTs', 'Receive']) { await pg.evaluate(h => { location.hash = '#' + h; }, r); await pg.waitForTimeout(800); if (!(await pg.locator('#page h1, #page h2').count())) return false; } return true; })());
  // Mining in the Desktop Wallet: the live download list, a verified rig-kit save, the dashboard link, and updates.
  { const kitFile = path.join(root, 'release/downloads/parano1d-world-rig-kit.zip'), kitSha = execFileSync('sha256sum', [kitFile]).toString().slice(0, 64), DL0 = path.join(HOME, 'Downloads');
    await pg.evaluate(() => { location.hash = '#Mining'; }); await pg.waitForTimeout(800);
    const DL = await ea.evaluate(({ app }) => app.getPath('downloads')).catch(() => DL0); await ea.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = u => { globalThis.__opened.push(u); return Promise.resolve(); }; shell.showItemInFolder = () => {}; });
    check('mining: the download list (with fingerprints) comes live from the site', await pg.evaluate(k => fetch('/downloads/manifest.json').then(r => r.json()).then(m => m.files['parano1d-world-rig-kit.zip'].sha256 === k), kitSha));
    const r1 = await pg.evaluate(() => fetch('/local/rigkit', { method: 'POST' }).then(r => r.json()));
    check('mining: the rig kit is saved to Downloads only after its SHA-256 matches the published one', r1.ok && r1.sha256 === kitSha && fs.existsSync(path.join(DL, r1.name)) && execFileSync('sha256sum', [path.join(DL, r1.name)]).toString().slice(0, 64) === kitSha);
    const orig = fs.readFileSync(kitFile); let r2;
    try { fs.writeFileSync(kitFile, Buffer.concat([orig, Buffer.from('x')])); r2 = await pg.evaluate(() => fetch('/local/rigkit', { method: 'POST' }).then(r => r.json())); } finally { fs.writeFileSync(kitFile, orig); }
    check('mining: a kit that does not match its fingerprint is refused and nothing is saved', !r2.ok && /did not match/.test(r2.error) && fs.readdirSync(DL).filter(f => f.startsWith('parano1d-world-rig-kit')).length === 1);
    check('mining: the published kit is signed (kitBuild in the live list) and verifies with the key built into the app', await (async () => { const m = JSON.parse(fs.readFileSync(path.join(root, 'release/downloads/manifest.json'), 'utf8')); const { verifyKit } = await import(path.join(root, 'rig-companion/kit-verify.mjs')); const v = verifyKit(fs.readFileSync(kitFile), fs.readFileSync(path.join(root, 'rig-companion/kit-public-key.pem'), 'utf8')); return /^[a-f0-9]{16}$/.test(m.files['parano1d-world-rig-kit.zip'].kitBuild) && crypto.createHash('sha256').update(v.files.get('KIT-MANIFEST.json')).digest('hex').startsWith(m.files['parano1d-world-rig-kit.zip'].kitBuild); })());
    check('mining: the This computer card offers the one-click CPU install here (Linux), with no GPU choice', await until(async () => { const t = await pg.innerText('#rig-local').catch(() => ''); return /Install mining on this computer/i.test(t) && /no administrator password/.test(t) && !(await pg.locator('#rig-local input[type=radio]').count()); }, 8000));
    check('mining: the app refuses GPU on Linux, a bad payout, and Update/Remove/Start when nothing is installed', await pg.evaluate(async () => { const p = (u, b) => fetch('/local/mining/' + u, { method: 'POST', body: JSON.stringify(b) }).then(r => r.status); return (await p('install', { kind: 'gpu', payout: 'o1' + 'a'.repeat(40) })) === 400 && (await p('install', { kind: 'cpu', payout: 'nope' })) === 400 && (await p('update', {})) === 409 && (await p('uninstall', { confirm: 'UNINSTALL' })) === 409 && (await p('start', {})) === 400; }));
    check('mining: other downloads are still blocked in the app', await pg.evaluate(() => fetch('/downloads/desktop/app.asar').then(r => r.status === 404)));
    if (await pg.locator('#ms-platform').count()) await pg.selectOption('#ms-platform', 'windows');
    const ms = pg.locator('#ms-kit-save'); check('mining: the Windows setup shows the in-app kit download', await until(async () => await ms.count() > 0, 8000)); { await ms.click(); check('mining: the setup page button saves the kit and reports the fingerprint', await until(async () => /Saved to .*SHA-256 matches/.test(await pg.innerText('#ms-kit-status')), 20000)); }
    await pg.evaluate(dash => { for (const [u, t] of [[dash + '/#uninstall', '_blank'], ['http://127.0.0.1:8080/', '_blank'], ['http://example.com/', '_blank'], ['https://parano1dworld.com/desktop-wallet', '_blank']]) window.open(u, t); }, DASHBOARD);
    await pg.waitForTimeout(600); const got = await ea.evaluate(() => globalThis.__opened);
    check('links: the mining dashboard (this computer only) and https pages open in the browser; other http addresses do not', got.includes(DASHBOARD + '/#uninstall') && got.includes('https://parano1dworld.com/desktop-wallet') && !got.some(u => u.includes(':8080') || u.startsWith('http://example.com')));
    // Pairing this Desktop Wallet with a rig: code from the rig's dashboard → signed Start / live hashrate / Stop → unpair.
    { const info = JSON.parse(fs.readFileSync(path.join(W, 'dev.json'), 'utf8'));
      const code = (await (await fetch(DASHBOARD + '/api/pair/new', { method: 'POST', headers: { origin: DASHBOARD, cookie: info.rigCookie, 'content-type': 'application/json' }, body: '{}' })).json()).code;
      await pg.evaluate(() => { location.hash = '#Home'; }); await pg.waitForTimeout(300); await pg.evaluate(() => { location.hash = '#Mining'; });
      await pg.waitForSelector('#pair-code', { state: 'visible', timeout: 15000 });
      check('pairing: the desktop asks for the code shown on the rig (no camera step)', (await pg.innerText('#rig-remote')).includes('type the code shown under the QR') && await pg.inputValue('#pair-name') === 'Desktop Wallet');
      await pg.fill('#pair-code', 'WRON-GCOD-EXXX'); await pg.click('#pair-form button[type=submit]');
      check('pairing: a wrong code is refused by the rig', await until(async () => (await pg.innerText('#pair-error')).includes('wrong or expired'), 8000));
      await pg.fill('#pair-code', code); await pg.click('#pair-form button[type=submit]');
      check('pairing: paired, rig status shown with the verified miner', await until(async () => await pg.locator('#rig-start').count() > 0, 15000) && (await pg.textContent('#rig-remote')).includes('GB v3.0.6 (verified)'));
      check('pairing: the device key stays on this computer and cannot be exported', await pg.evaluate(async () => { const db = await new Promise(r => { const q = indexedDB.open('parano1d-world-device', 1); q.onsuccess = () => r(q.result); }); const recs = await new Promise(r => { const g = db.transaction('keys').objectStore('keys').getAll(); g.onsuccess = () => r(g.result); }); return recs.length > 0 && recs.every(x => x.keyPair && x.keyPair.privateKey.extractable === false); }));
      await pg.click('#rig-start');
      check('pairing: Start is signed and accepted; live hashrate appears', await until(async () => (await pg.innerText('#mining-metrics')).includes('MH/s'), 25000));
      await pg.click('#rig-stop');
      check('pairing: Stop is confirmed', await until(async () => await pg.locator('#rig-start').count() > 0 && (await pg.innerText('#rig-remote')).includes('confirmed'), 25000));
      await pg.reload(); await pg.waitForSelector('#rig-start', { timeout: 15000 }).catch(() => {});
      check('pairing: still paired after a restart of the page', await pg.locator('#rig-start').count() > 0);
      const unpair = pg.locator('#rig-unpair'); if (await unpair.count()) { await unpair.click(); const yes = pg.locator('#rig-unpair-yes, #confirm-yes'); if (await yes.count()) await yes.first().click(); }
      check('pairing: unpair returns to the pairing form', await until(async () => await pg.locator('#pair-code').count() > 0, 10000));
    }
    check('updates: a newer published Desktop Wallet is announced (never installed by itself)', await until(async () => await pg.locator('#dk-update').count() > 0, 10000) && (await pg.innerText('#dk-update')).includes('new Desktop Wallet version'));
  }
  check('no page errors', errs.length === 0) || console.log(errs.slice(0, 3));
  await ea.close();
  // Installed form: fuses flipped by the installer's own perl code; packaged app starts and stays running.
  const sh = fs.readFileSync(path.join(root, 'desktop/installers/install.sh'), 'utf8'), perl = sh.slice(sh.indexOf("perl -e '") + 9, sh.indexOf("' \"$1\" \"$2\""));
  const pk = path.join(W, 'pk'); execFileSync('unzip', ['-q', ZIP, '-d', pk]); fs.rmSync(path.join(pk, 'resources/default_app.asar'), { force: true });
  await asar.createPackage(app, path.join(pk, 'resources/app.asar')); fs.renameSync(path.join(pk, 'electron'), path.join(pk, 'parano1d-world-wallet'));
  execFileSync('perl', ['-e', perl, path.join(pk, 'parano1d-world-wallet'), '0']); prepRuntime(pk); const run1 = asUser(pk);
  const wire = await fuses.getCurrentFuseWire(path.join(pk, 'parano1d-world-wallet')); const F = fuses.FuseV1Options, on = k => wire[k] === fuses.FuseState.ENABLE;
  check('fuses: no Node mode, no NODE_OPTIONS, no --inspect, asar only, cookie encryption, no file:// privileges', !on(F.RunAsNode) && !on(F.EnableNodeOptionsEnvironmentVariable) && !on(F.EnableNodeCliInspectArguments) && on(F.OnlyLoadAppFromAsar) && on(F.EnableCookieEncryption) && !on(F.GrantFileProtocolExtraPrivileges));
  const run = spawn(run1, [], { env: { ...process.env, P1W_BIN: 'parano1d-world-wallet' } }); let died = null; run.on('exit', c => { died = c; });
  await new Promise(r => setTimeout(r, 9000)); check('installed app starts (sandboxed) and keeps running', died === null); execFileSync('pkill', ['-f', path.join(pk, 'parano1d-world-wallet')]);
  const asNode = spawn(run1, ['-e', 'console.log(1)'], { env: { ...process.env, P1W_BIN: 'parano1d-world-wallet', ELECTRON_RUN_AS_NODE: '1' } }); let out = ''; asNode.stdout.on('data', d => out += d);
  await new Promise(r => setTimeout(r, 4000)); asNode.kill(); check('cannot be abused as a Node.js interpreter (ELECTRON_RUN_AS_NODE ignored)', !out.includes('1\n'));
  const dbg = spawn(run1, ['--remote-debugging-port=9333'], { env: { ...process.env, P1W_BIN: 'parano1d-world-wallet' } }); let dbgExit = null; dbg.on('exit', c => { dbgExit = c; });
  await new Promise(r => setTimeout(r, 5000)); check('refuses to start with a remote-debugging port', dbgExit !== null); dbg.kill();
  // W1: the checksum file matches what ships, the page shows the real checksums, and the installer refuses altered files.
  { const D = path.join(root, 'release/downloads/desktop'), sha = f => execFileSync('sha256sum', [f]).toString().slice(0, 64);
    const sums = fs.readFileSync(path.join(D, 'SHA256SUMS'), 'utf8').trim().split('\n').map(l => l.split(/\s+/));
    check('SHA256SUMS matches every shipped desktop file', sums.length >= 5 && sums.every(([h, f]) => sha(path.join(D, f)) === h));
    const page = fs.readFileSync(path.join(root, 'release/desktop-wallet.html'), 'utf8');
    check('download page shows the real checksums and never pipes a download into a shell', !/__SHA_/.test(page) && page.includes(sha(path.join(D, 'install.sh'))) && !/install\.sh \| sh\b/.test(page));
    const srv2 = path.join(W, 'srv'), dd = path.join(srv2, 'downloads/desktop'); fs.mkdirSync(dd, { recursive: true });
    for (const f of fs.readdirSync(D)) fs.copyFileSync(path.join(D, f), path.join(dd, f));
    fs.appendFileSync(path.join(dd, 'app.asar'), 'tampered');
    const inst = path.join(W, 'inst.sh'); fs.writeFileSync(inst, fs.readFileSync(path.join(D, 'install.sh'), 'utf8').replace(/^SITE=.*$/m, "SITE='http://127.0.0.1:8833'").replace("--proto '=https' ", ''));
    const hs = spawn('python3', ['-m', 'http.server', '8833', '--bind', '127.0.0.1'], { cwd: srv2, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 1200));
    const h2 = path.join(W, 'home2'); fs.mkdirSync(h2);
    let out = ''; try { out = execFileSync('sh', [inst], { env: { PATH: process.env.PATH, HOME: h2, P1W_TEST_ELECTRON_ZIP: ZIP }, stdio: 'pipe' }).toString(); } catch (e) { out = String(e.stdout) + String(e.stderr); }
    hs.kill();
    check('installer refuses an altered wallet app and installs nothing', /does not match its published checksum/.test(out) && !fs.existsSync(path.join(h2, '.local/opt/parano1d-world-wallet')));
  }
} catch (e) { console.log('ERROR', e.message.split('\n')[0], e.message.match(/waiting for locator\('([^']+)/)?.[1]); try { console.log('MODAL', (await globalThis.__pg.textContent('#modal-root'))?.slice(0, 400), 'SENDERR', await globalThis.__pg.textContent('#send-error').catch(() => '')); console.log(globalThis.__cons.slice(-15).join('\n')); } catch {} results.push(false); }
finally { srv.kill(); try { execFileSync('pkill', ['-f', W]); } catch {} await new Promise(r => setTimeout(r, 1500)); xvfb?.kill(); fs.rmSync(W, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); }
console.log(`desktop wallet: ${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
