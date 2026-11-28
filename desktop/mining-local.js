// Desktop Wallet: install, update, control and remove mining on THIS computer.
//
// Windows: the signed rig kit (dashboard, GPU miner or CPU node), run with Windows' permission prompt.
//   The kit comes from parano1dworld.com; its size and SHA-256 must match the live download list, its manifest must
//   carry the Parano1d World kit signature (public key built into this app), and every file must match that list.
// Mac and Linux: CPU mining with the official Parano1d node, for this user only (no administrator password).
//   The node archive comes from the official GitHub release and must match the SHA-256 pinned below. The mining
//   dashboard is the one inside this app (covered by the app's own pinned hash) and runs as a background service
//   (Mac LaunchAgent / Linux systemd user service), so mining continues after the wallet window is closed.
// Everywhere: only fixed steps with fixed arguments run; nothing the page sends reaches a command line. The app
// controls the miner on this computer directly (127.0.0.1), so no pairing is needed for that.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), net = require('net');
const { spawn } = require('child_process'), { pathToFileURL } = require('url'), http = require('http');
const { miningPaths, SERVICE_LABEL, SERVICE_UNIT } = require('./mining-paths.js');
const { DASHBOARD, DASHBOARD_HOST, DASHBOARD_PORT, NODE_P2P_PORT, NODE_RPC_PORT } = require('./local-ports.js');

// Loopback only (the local dashboard, local-ports.js), via Node's http so the Origin header the dashboard requires is sent as written.
function local(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: DASHBOARD_HOST, port: DASHBOARD_PORT, method, path: p, timeout: 15000, headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, rs => {
      const chunks = []; let n = 0;
      rs.on('data', c => { n += c.length; if (n > 2e6) rq.destroy(new Error('Response too large')); else chunks.push(c); });
      rs.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ status: rs.statusCode, headers: rs.headers, json }); });
    });
    rq.on('timeout', () => rq.destroy(new Error('The mining dashboard did not answer.'))); rq.on('error', reject);
    if (data) rq.write(data); rq.end();
  });
}
// Is a TCP port free on this computer? (Another node or another dashboard on the same ports would clash.)
function portFree(port, host) { return new Promise(r => { const s = net.createServer(); s.once('error', () => r(false)); s.listen({ port, host, exclusive: true }, () => s.close(() => r(true))); }); }

const DASH = DASHBOARD, ZIP = 'parano1d-world-rig-kit.zip';
const ADDR = /^o1[a-z0-9]{20,140}$/;
// Official Parano1d node (github.com/proof-native/parano1d, release v2.1.0), SHA-256 from that release's SHA256SUMS.
const CORE = { version: '2.1.0', base: 'https://github.com/proof-native/parano1d/releases/download/v2.1.0/', files: {
  'darwin-arm64': ['parano1d-core-v2.1.0-macos-aarch64.tar.gz', '528acdda17c9dab9e9f7d5411b2f624893aae6ce49e7f15df83f18720bb12a0f'],
  'darwin-x64': ['parano1d-core-v2.1.0-macos-x86_64.tar.gz', '2eb5ac54e297f1522e3d29670db1dc6d660a8734bc4d099234b5ac0dd4a50466'],
  'linux-x64': ['parano1d-core-v2.1.0-linux-x86_64.tar.gz', 'f7c0ca22899e6a157fd61d0e140ba67b8c69c5a60d5bad19c6d2269adc6973fa'],
  'linux-arm64': ['parano1d-core-v2.1.0-linux-aarch64.tar.gz', 'c776772eda80ba33bbb6c06d74b9c5a96c790daf60ef5e02605ee368131e789f'],
} };
const MAX_CORE_BYTES = 400 * 1024 * 1024;

module.exports = function createLocalMining({ app, fetchSite, liveManifest, jsonRes, publicKey, appBuild = 'unknown', netFetch = globalThis.fetch,
  platform = process.platform, arch = process.arch, env = process.env, spawnImpl = spawn, localImpl = local, portFreeImpl = portFree,
  core = CORE, uid = (() => { try { return os.userInfo().uid; } catch { return -1; } })(), serviceCommand = null }) {
  let job = null; // { action, state, since, error?, result? }
  const WIN = platform === 'win32', POSIX = platform === 'darwin' || platform === 'linux';
  const read = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const busy = () => job && ['starting', 'downloading', 'verifying', 'waiting', 'running', 'installing', 'pairing'].includes(job.state);
  const set = (state, extra = {}) => { job = { ...(job || {}), state, since: Date.now(), ...extra }; };
  const home = app.getPath('home');
  // Windows kit locations (same as Start-Here.ps1) | Mac/Linux app-managed locations (mining-paths.js).
  const winLocal = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const W = { companion: path.join(winLocal, 'Parano1dWorld', 'rig-companion'), data: path.join(winLocal, 'Parano1dWorld', 'rig-data') };
  const P = miningPaths(home, platform, env);
  const dataDir = WIN ? W.data : P.rigData;
  const installed = () => (WIN ? fs.existsSync(path.join(W.companion, 'agent.mjs')) : POSIX && fs.existsSync(P.serviceFile) && fs.existsSync(platform === 'darwin' ? P.plist : P.unit));
  const kitBuild = () => { const t = read(path.join(W.companion, 'kit-build.txt')); return /^[a-f0-9]{16}$/.test(t || '') ? t : null; };

  async function dashUp() { try { return (await localImpl('GET', '/')).status === 200; } catch { return false; } }
  async function waitDash(ms = 90000) { const end = Date.now() + ms; while (Date.now() < end) { if (await dashUp()) return true; await new Promise(r => setTimeout(r, 1500)); } return false; }

  // ---- the dashboard's access code (same user's private file) → a session, kept in memory and renewed if needed ----
  let cookie = null;
  async function login() {
    const code = (read(path.join(dataDir, 'ACCESS-CODE.txt')) || '').match(/^[a-f0-9]{48}$/m)?.[0];
    if (!code) throw new Error('The mining dashboard is not signed in on this computer yet.');
    const r = await localImpl('POST', '/login', { headers: { origin: DASH }, body: { token: code } });
    cookie = [].concat(r.headers['set-cookie'] || []).join(';').match(/rig_session=([a-f0-9]{64})/)?.[1] || null;
    if (r.status !== 200 || !cookie) { cookie = null; throw new Error('The mining dashboard did not accept this computer\'s access code.'); }
  }
  async function call(p, body, method = 'POST') {
    for (let i = 0; i < 2; i++) {
      if (!cookie) await login();
      const x = await localImpl(method, p, { headers: { origin: DASH, cookie: 'rig_session=' + cookie }, ...(method === 'POST' ? { body: body || {} } : {}) });
      if (x.status === 401 && i === 0) { cookie = null; continue; }
      if (x.status >= 300 || !x.json || x.json.ok === false) throw new Error(x.json?.error || 'Dashboard request failed');
      return x.json;
    }
  }

  // ---- run a command with fixed arguments (no shell), with a time limit; output is kept short ----
  function run(cmd, args, { timeout = 60000, input, max = 4000 } = {}) {
    return new Promise(resolve => {
      let out = '', done = false;
      const ps = spawnImpl(cmd, args, { shell: false, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const t = setTimeout(() => { try { ps.kill('SIGKILL'); } catch {} }, timeout);
      const add = d => { if (out.length < max) out += d.toString(); };
      ps.stdout?.on('data', add); ps.stderr?.on('data', add);
      if (input) { ps.stdin.end(input); }
      const fin = code => { if (done) return; done = true; clearTimeout(t); resolve({ code, out: out.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim() }); };
      ps.on('exit', fin); ps.on('error', e => { out += String(e.message || e); fin(-1); });
    });
  }

  // ================= Windows: the signed rig kit =================
  async function fetchKit() {
    const kv = [path.join(__dirname, 'kit-verify.mjs'), path.join(__dirname, '..', 'rig-companion', 'kit-verify.mjs')].find(f => fs.existsSync(f)); // packaged app | source tree
    const { verifyKit, extractKit } = await import(pathToFileURL(kv).href);
    set('downloading');
    const entry = (await liveManifest()).files?.[ZIP];
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 25 * 1024 * 1024) throw new Error('The published fingerprint for the mining kit is missing, so nothing was installed.');
    const buf = Buffer.from(await (await fetchSite('/downloads/' + ZIP, 'application/zip')).arrayBuffer());
    if (buf.length !== entry.bytes || crypto.createHash('sha256').update(buf).digest('hex') !== entry.sha256) throw new Error('The downloaded kit did not match its published fingerprint, so nothing was installed.');
    set('verifying');
    const { files } = verifyKit(buf, publicKey); // signature + every file
    const root = path.join(app.getPath('userData'), 'mining-kit');
    try { for (const d of fs.readdirSync(root)) fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch {}
    return extractKit(files, path.join(root, Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex')));
  }
  // The non-admin wrapper exits when Windows' prompt is answered (1223 = declined).
  function runElevated(file, args, resultFile) {
    const q = v => String(v).replace(/'/g, "''");
    const argList = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${q(file)}"`, ...args.map(a => (a.startsWith('-') ? a : `"${q(a)}"`))].join(' ');
    const wrap = `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '${argList}' -ErrorAction Stop; exit $p.ExitCode } catch { exit 1223 }`;
    set('waiting');
    return new Promise(resolve => {
      const ps = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrap], { shell: false, windowsHide: true, stdio: 'ignore' });
      const poll = setInterval(() => { if (job?.state === 'waiting' && fs.existsSync(resultFile)) set('running'); }, 1000);
      const done = code => { clearInterval(poll); let out = null; try { out = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {} resolve({ code, out }); };
      ps.on('exit', done); ps.on('error', () => done(-1));
    });
  }
  async function winInstall({ kind, p2p }) {
    const dir = await fetchKit(), res = path.join(dir, 'result.json');
    const args = ['-Auto', '-Kind', kind === 'gpu' ? 'G' : 'C', ...(kind === 'cpu' && p2p ? ['-AllowInboundP2P'] : []), '-Result', res];
    const { code, out } = await runElevated(path.join(dir, 'rig-node-kit', 'Start-Here.ps1'), args, res);
    if (code === 1223 && !out) return 'declined';
    if (!out || out.ok !== true) throw new Error(out?.error || 'The installer did not finish. Nothing more was changed.');
    return 'ok';
  }
  async function winUpdate() {
    const dir = await fetchKit(), res = path.join(dir, 'result.json');
    const { code, out } = await runElevated(path.join(dir, 'rig-node-kit', 'Start-Here.ps1'), ['-Auto', '-UpdateMiner', '-Result', res], res);
    if (code === 1223 && !out) return 'declined';
    if (!out || out.ok !== true) throw new Error(out?.error || 'The update did not finish. Nothing more was changed.');
    return 'ok';
  }
  async function winUninstall({ deleteChain }) {
    const script = path.join(W.companion, 'Uninstall-Mining.ps1');
    if (!fs.existsSync(script)) throw new Error('The mining uninstaller is not on this computer. Use Windows Settings → Apps → Parano1d World Mining.');
    const res = path.join(app.getPath('userData'), 'uninstall-result-' + Date.now() + '.json');
    const { code, out } = await runElevated(script, ['-Quiet', ...(deleteChain ? ['-DeleteChain'] : []), '-Result', res,
      // Remove this Windows user's files even if a different administrator account approves the prompt.
      '-UserLocal', winLocal, '-UserDesktop', app.getPath('desktop'), '-UserStart', path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')], res);
    try { fs.rmSync(res, { force: true }); } catch {}
    if (code === 1223 && !out) return { declined: true };
    if (!out || out.ok !== true) throw new Error(out?.error || 'The uninstaller did not finish.');
    return { removed: Array.isArray(out.removed) ? out.removed.filter(x => typeof x === 'string').slice(0, 10) : [] };
  }

  // ================= Mac / Linux: official node + this app's dashboard as a user service =================
  const coreEntry = () => core.files[`${platform}-${arch}`] || null;
  const coreDir = v => path.join(P.core, 'v' + v);
  async function ensureCore() {
    const ent = coreEntry(); if (!ent) throw new Error(`There is no official Parano1d node for this computer (${platform} ${arch}).`);
    const [file, pin] = ent, dir = coreDir(core.version), bin = path.join(dir, 'parano1d'), cli = path.join(dir, 'parano1d-cli');
    const svc = readJson(P.serviceFile);
    if (svc?.core === core.version && svc.coreBinarySha256 && svc.coreCliBinarySha256 && fs.existsSync(bin) && fs.existsSync(cli) && sha256File(bin) === svc.coreBinarySha256 && sha256File(cli) === svc.coreCliBinarySha256) return { bin, sha: svc.coreBinarySha256, cli, cliSha: svc.coreCliBinarySha256 };
    set('downloading', { detail: 'node' });
    const r = await netFetch(core.base + file, { redirect: 'follow', cache: 'no-store' });
    if (!r.ok) throw new Error('The official Parano1d node could not be downloaded (HTTP ' + r.status + '). Nothing was installed.');
    const len = Number(r.headers.get('content-length') || 0); if (len > MAX_CORE_BYTES) throw new Error('The node download is larger than expected, so it was refused.');
    const buf = Buffer.from(await r.arrayBuffer());
    set('verifying');
    if (buf.length > MAX_CORE_BYTES || crypto.createHash('sha256').update(buf).digest('hex') !== pin) throw new Error('The downloaded node did not match its pinned fingerprint, so nothing was installed.');
    fs.mkdirSync(P.core, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(P.core, '.dl-'));
    try {
      const tgz = path.join(tmp, file); fs.writeFileSync(tgz, buf, { mode: 0o600 });
      // List first: only plain relative names; the archive must contain the node program itself.
      const ls = await run('tar', ['-tzf', tgz]);
      const names = ls.out.split('\n').map(s => s.trim()).filter(Boolean);
      if (ls.code !== 0 || !names.length || names.some(n => n.startsWith('/') || n.split('/').includes('..'))) throw new Error('The node archive could not be read safely, so nothing was installed.');
      // The node and its command-line client (used to stop the node safely); nothing else is unpacked.
      const members = ['parano1d', 'parano1d-cli'].map(m => names.find(n => n === m || n === './' + m));
      if (members.some(m => !m)) throw new Error('The node archive does not contain the node program.');
      const x = path.join(tmp, 'x'); fs.mkdirSync(x, { mode: 0o700 });
      const ex = await run('tar', ['-xzf', tgz, '-C', x, ...members]);
      for (const m of ['parano1d', 'parano1d-cli']) { const got = path.join(x, m), st = fs.existsSync(got) ? fs.lstatSync(got) : null; if (ex.code !== 0 || !st || !st.isFile()) throw new Error('The node program could not be unpacked, so nothing was installed.'); fs.chmodSync(got, 0o755); }
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(x, 'parano1d'), bin); fs.renameSync(path.join(x, 'parano1d-cli'), cli);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    // The official program checks this computer's processor (SSE4.1+PCLMULQDQ / NEON+PMULL) before anything else.
    const hw = await run(bin, ['--check-hardware'], { timeout: 60000 });
    if (hw.code !== 0) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('This computer\'s processor cannot run the Parano1d node: ' + (hw.out.split('\n').filter(Boolean).slice(-2).join(' ') || 'hardware check failed').slice(0, 240)); }
    return { bin, sha: sha256File(bin), cli, cliSha: sha256File(cli) };
  }
  function serviceArgs() {
    // The installed app (resources/app.asar) needs no app path; an unpacked one (tests, development) does.
    const a = [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), '--p1w-mining-service'];
    if (platform === 'linux') a.push('--ozone-platform=headless'); // no window, so no display server is needed
    return serviceCommand ? serviceCommand(a) : a;
  }
  const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sysdQuote = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
  async function serviceStart() {
    const a = serviceArgs();
    if (platform === 'darwin') {
      fs.mkdirSync(path.dirname(P.plist), { recursive: true });
      fs.writeFileSync(P.plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${a.map(x => `<string>${xml(x)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Standard</string>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`, { mode: 0o644 });
      await run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]); // not loaded yet is fine
      const r = await run('launchctl', ['bootstrap', `gui/${uid}`, P.plist]);
      if (r.code !== 0) { const l = await run('launchctl', ['load', '-w', P.plist]); if (l.code !== 0) throw new Error('macOS did not start the mining service: ' + (r.out || l.out).slice(0, 200)); }
    } else {
      fs.mkdirSync(path.dirname(P.unit), { recursive: true });
      fs.writeFileSync(P.unit, `[Unit]
Description=Parano1d World Mining (local dashboard and CPU miner, started by the Parano1d World Desktop Wallet)

[Service]
ExecStart=${a.map(sysdQuote).join(' ')}
Restart=on-failure
RestartSec=10
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`, { mode: 0o644 });
      const d = await run('systemctl', ['--user', 'daemon-reload']);
      if (d.code !== 0) throw new Error('This Linux system has no user service manager (systemd --user), so mining could not be set up to run in the background.');
      const e = await run('systemctl', ['--user', 'enable', '--now', SERVICE_UNIT]);
      if (e.code !== 0) throw new Error('Linux did not start the mining service: ' + e.out.slice(0, 200));
    }
  }
  async function serviceRestart() {
    if (platform === 'darwin') { const r = await run('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`]); if (r.code !== 0) await serviceStart(); }
    else { const r = await run('systemctl', ['--user', 'restart', SERVICE_UNIT]); if (r.code !== 0) throw new Error('Linux did not restart the mining service: ' + r.out.slice(0, 200)); }
  }
  async function serviceRemove() {
    if (platform === 'darwin') { await run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]); fs.rmSync(P.plist, { force: true }); }
    else { await run('systemctl', ['--user', 'disable', '--now', SERVICE_UNIT]); fs.rmSync(P.unit, { force: true }); await run('systemctl', ['--user', 'daemon-reload']); }
  }
  // Any node process left running from this app's own node folder (never any other program).
  async function stopOwnNode() {
    const r = await run('ps', ['-A', '-o', 'pid=,command='], { max: 4e6 }); const mine = [];
    for (const line of r.out.split('\n')) { const m = line.trim().match(/^(\d+)\s+(.*)$/); if (m && m[2].startsWith(P.core + path.sep)) mine.push(Number(m[1])); }
    for (const pid of mine) { try { process.kill(pid, 'SIGINT'); } catch {} }
    if (mine.length) await new Promise(r => setTimeout(r, 4000));
    for (const pid of mine) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }
    return mine.length;
  }
  function writeRigConfig(extra) {
    fs.mkdirSync(P.rigData, { recursive: true, mode: 0o700 });
    const f = path.join(P.rigData, 'rig-config.json'), c = { ...(readJson(f) || {}), ...extra };
    fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
  }
  async function posixInstall({ p2p, payout }) {
    // Refuse instead of clashing with a node or dashboard that's already running here (nothing is changed).
    for (const [port, host, what] of [[DASHBOARD_PORT, DASHBOARD_HOST, 'a mining dashboard'], [NODE_RPC_PORT, '127.0.0.1', 'a Parano1d node'], [NODE_P2P_PORT, '0.0.0.0', 'a Parano1d node']]) {
      if (!(await portFreeImpl(port, host))) throw new Error(`Port ${port} is already in use on this computer (${what} may already be running). Stop it first; nothing was installed.`);
    }
    const { bin, sha, cli, cliSha } = await ensureCore();
    set('installing');
    fs.mkdirSync(P.chain, { recursive: true, mode: 0o700 });
    writeRigConfig({ payoutAddress: payout, preferredMode: 'cpu-solo', coreBinary: bin, coreBinarySha256: sha, coreCliBinary: cli, coreCliBinarySha256: cliSha });
    fs.writeFileSync(P.serviceFile, JSON.stringify({ version: 1, core: core.version, coreBinarySha256: sha, coreCliBinarySha256: cliSha, p2p: p2p ? 'open' : 'local', installedAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
    try { await serviceStart(); } catch (e) { await serviceRemove().catch(() => {}); throw e; }
    return 'ok';
  }
  async function posixUpdate() {
    const svc = readJson(P.serviceFile) || {};
    try { await call('/api/stop', {}); } catch {} // mining stops during the update
    await stopOwnNode();
    const { bin, sha, cli, cliSha } = await ensureCore();
    set('installing');
    writeRigConfig({ coreBinary: bin, coreBinarySha256: sha, coreCliBinary: cli, coreCliBinarySha256: cliSha });
    fs.writeFileSync(P.serviceFile, JSON.stringify({ ...svc, core: core.version, coreBinarySha256: sha, coreCliBinarySha256: cliSha, updatedAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
    fs.rmSync(P.runningFile, { force: true });
    await serviceStart(); // rewrites the service with this app's current location, then (re)starts it
    for (const d of fs.readdirSync(P.core)) if (d !== 'v' + core.version) fs.rmSync(path.join(P.core, d), { recursive: true, force: true }); // older node versions
    return 'ok';
  }
  async function posixUninstall({ deleteChain }) {
    const removed = [];
    try { await call('/api/stop', {}); } catch {}
    await serviceRemove(); removed.push('background service');
    if (await stopOwnNode()) removed.push('running node');
    for (const [p, name] of [[P.core, 'node program'], [P.rigData, 'dashboard settings'], [P.profile, null], [P.serviceFile, null], [P.runningFile, null], ...(deleteChain ? [[P.chain, 'chain copy']] : [])]) {
      if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); if (name) removed.push(name); }
    }
    try { if (!fs.readdirSync(P.base).length) fs.rmdirSync(P.base); } catch {}
    cookie = null;
    return { removed, keptChain: !deleteChain && fs.existsSync(P.chain) };
  }

  // ================= shared steps =================
  async function install(o) {
    const r = WIN ? await winInstall(o) : await posixInstall(o);
    if (r === 'declined') return set('declined');
    set('pairing'); cookie = null;
    if (!(await waitDash())) return set('failed', { error: WIN ? 'Mining was installed, but its dashboard did not start. Open "Parano1d Mining" from the desktop.' : 'Mining was installed, but its dashboard did not start. Press Update Miner to restart it.' });
    await call('/api/wallets', { address: o.payout, label: String(o.label || 'Desktop Wallet').slice(0, 40) });
    const started = o.start ? await call('/api/quickstart', { kind: o.kind, payoutAddress: o.payout }).then(() => true, () => false) : false;
    return set('done', { result: { installed: true, started, startFailed: Boolean(o.start && !started) } });
  }
  async function update() {
    const r = WIN ? await winUpdate() : await posixUpdate();
    if (r === 'declined') return set('declined');
    set('pairing'); cookie = null;
    if (!(await waitDash())) return set('failed', { error: 'The update finished, but the dashboard has not started yet. Try Update Miner again.' });
    return set('done', { result: { updated: true } });
  }
  async function uninstall(o) {
    const r = WIN ? await winUninstall(o) : await posixUninstall(o);
    if (r.declined) return set('declined');
    return set('done', { result: r });
  }

  function currentBuild() {
    if (WIN) return kitBuild();
    const run_ = readJson(P.runningFile), svc = readJson(P.serviceFile);
    return run_?.build && svc?.core ? `${run_.build}+${svc.core}` : null;
  }
  async function latestBuild() {
    if (WIN) { try { return (await liveManifest()).files?.[ZIP]?.kitBuild || null; } catch { return null; } }
    return `${appBuild}+${core.version}`;
  }
  // Live state of the miner on this computer, straight from its dashboard (no pairing).
  async function control() {
    const s = await call('/api/status', null, 'GET'), t = s.telemetry || {};
    return { running: Boolean(s.running), mode: s.launched?.mode || s.preferredMode || null, preferredMode: s.preferredMode || null, hashrate: typeof t.hashrateText === 'string' ? t.hashrateText.slice(0, 40) : null,
      accepted: Number.isFinite(t.accepted) ? t.accepted : null, rejected: Number.isFinite(t.rejected) ? t.rejected : null, startedAt: s.startedAt || null,
      payout: typeof s.payout === 'string' ? s.payout : null, pool: typeof s.launched?.pool === 'string' ? s.launched.pool.slice(0, 60) : null, worker: typeof (s.launched?.worker || s.settings?.worker) === 'string' ? String(s.launched?.worker || s.settings.worker).slice(0, 24) : null, note: s.stop?.message || s.safetyEvent?.message || null, phoneControl: s.phoneControl ? { enabled: s.phoneControl.enabled === true, since: typeof s.phoneControl.since === 'string' ? s.phoneControl.since : null } : null,
      lastLog: Array.isArray(s.logs) && s.logs.length ? String(s.logs[s.logs.length - 1].line || '').slice(0, 200) : null };
  }

  const start = (action, fn) => { if (busy()) return jsonRes({ ok: false, error: 'Another mining step is still running.' }, 409); job = { action, state: 'starting', since: Date.now() }; fn().catch(e => set('failed', { error: String(e?.message || e).slice(0, 300) })); return jsonRes({ ok: true, job }, 202); };
  let phoneToken = null; // the rig's one-time confirm token, kept in the app only
  const body = async req => { try { const t = await req.text(); return t.length > 2000 ? {} : JSON.parse(t || '{}'); } catch { return {}; } };

  return async function route(req, u) {
    const p = u.pathname.slice('/local/mining/'.length);
    const supported = WIN || (POSIX && Boolean(coreEntry()));
    if (p === 'status' && req.method === 'GET') {
      const inst = supported && installed(), cur = inst ? currentBuild() : null, latest = supported ? await latestBuild() : null;
      return jsonRes({ ok: true, supported, platform, kinds: WIN ? ['gpu', 'cpu'] : ['cpu'], installed: inst, current: cur, latest,
        updateAvailable: Boolean(inst && latest && latest !== cur), dashboard: inst ? await dashUp() : false, job });
    }
    if (!supported) return jsonRes({ ok: false, error: POSIX ? 'There is no official Parano1d node for this processor.' : 'Installing mining from the app works on Windows, Mac and Linux.' }, 400);
    if (p === 'install' && req.method === 'POST') {
      const b = await body(req);
      if (!(WIN ? ['gpu', 'cpu'] : ['cpu']).includes(b.kind)) return jsonRes({ ok: false, error: WIN ? 'Choose GPU or CPU.' : 'On this computer, mining uses the processor (CPU).' }, 400);
      const payout = String(b.payout || '').trim().toLowerCase(); if (!ADDR.test(payout)) return jsonRes({ ok: false, error: 'Choose the wallet that receives the mining rewards.' }, 400);
      if (installed()) return jsonRes({ ok: false, error: 'Mining is already installed on this computer.' }, 409);
      return start('install', () => install({ kind: b.kind, p2p: b.p2p === true, payout, label: typeof b.label === 'string' ? b.label.replace(/[^\w .'-]/g, '') : '', start: b.start === true }));
    }
    if (p === 'update' && req.method === 'POST') { if (!installed()) return jsonRes({ ok: false, error: 'Mining is not installed on this computer.' }, 409); return start('update', update); }
    if (p === 'uninstall' && req.method === 'POST') { const b = await body(req); if (String(b.confirm || '').trim().toUpperCase() !== 'UNINSTALL') return jsonRes({ ok: false, error: 'Type UNINSTALL to confirm.' }, 400); if (!installed()) return jsonRes({ ok: false, error: 'Mining is not installed on this computer.' }, 409); return start('uninstall', () => uninstall({ deleteChain: b.deleteChain === true })); }
    // Control the miner on this computer directly: status, Start, Stop. (Payout, pool and miner are changed only
    // in the dashboard itself.)
    if (p === 'control' && req.method === 'GET') { try { return jsonRes({ ok: true, ...(await control()) }); } catch (e) { return jsonRes({ ok: false, error: e.message }, 400); } }
    if ((p === 'start' || p === 'stop') && req.method === 'POST') {
      if (busy()) return jsonRes({ ok: false, error: 'Wait for the current mining step to finish.' }, 409);
      try {
        if (p === 'stop') { const r = await call('/api/stop', {}); return jsonRes({ ok: true, stopping: true, note: r.note || null }); }
        const s = await call('/api/status', null, 'GET'), mode = ['cpu-solo', 'gpu-pool', 'gpu-solo-pool'].includes(s.preferredMode) ? s.preferredMode : 'cpu-solo';
        const r = await call('/api/start', { mode }); return jsonRes({ ok: true, started: true, mode, note: r.note || null });
      } catch (e) { return jsonRes({ ok: false, error: e.message }, 400); }
    }
    // Phone control switch (owner request 25 Nov): OFF by default; the rig enforces it. Turning it ON is two steps:
    // request (the page shows the rig's notice) and confirm. The rig's one-time token stays here in the app; the page
    // never sees it, so another tab or script can't skip the notice.
    if (p === 'phone-control/request' && req.method === 'POST') {
      try { const r = await call('/api/phone-control/request', {}); phoneToken = r.enabled ? null : r.confirmToken; return jsonRes({ ok: true, enabled: Boolean(r.enabled), notice: r.notice || null, expiresAt: r.expiresAt || null }); }
      catch (e) { return jsonRes({ ok: false, error: e.message }, 400); }
    }
    if (p === 'phone-control/confirm' && req.method === 'POST') {
      const b = await body(req); if (b.confirm !== 'ALLOW') return jsonRes({ ok: false, error: 'Confirm with the Allow button.' }, 400);
      if (!phoneToken) return jsonRes({ ok: false, error: 'Turn the switch on first.' }, 400);
      const token = phoneToken; phoneToken = null;
      try { const r = await call('/api/phone-control/confirm', { token, confirm: 'ALLOW' }); return jsonRes({ ok: true, enabled: Boolean(r.enabled) }); }
      catch (e) { return jsonRes({ ok: false, error: e.message }, 400); }
    }
    if (p === 'phone-control/off' && req.method === 'POST') {
      const b = await body(req); phoneToken = null;
      try { await call('/api/phone-control/off', { revokeDevices: b.revokeDevices === true }); return jsonRes({ ok: true, enabled: false }); }
      catch (e) { return jsonRes({ ok: false, error: e.message }, 400); }
    }
    if (p === 'pair-code' && req.method === 'POST') {
      try { if (!(await dashUp())) throw new Error('The mining dashboard is not running on this computer.'); const r = await call('/api/pair/new'); return jsonRes({ ok: true, code: r.code, expiresAt: r.expiresAt || null }); }
      catch (e) { return jsonRes({ ok: false, error: e.message }, 400); }
    }
    return jsonRes({ ok: false, error: 'Not found' }, 404);
  };
};
function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
module.exports.CORE = CORE;
