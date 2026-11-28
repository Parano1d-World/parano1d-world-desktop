// Sites that use the shared Parano1d wallet standard (Noidium) open in the app's own window, where this wallet is
// offered to them like the browser extension. The site runs in its own sandboxed, separate storage; it never sees the
// wallet's storage or keys. Each request goes to a small wallet window (site-approve.html, served from this app) with
// the site's real address taken from the window by this process, never from the page.
'use strict';
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const SITES = [/^https:\/\/(?:[a-z0-9-]+\.)?noidium\.com$/]; // the sites allowed to use the wallet here
const METHODS = new Set(['version', 'connect', 'accounts', 'balanceState', 'nativeRequest', 'open', 'disconnect', 'signIn']);
const allowedOrigin = url => { try { const u = new URL(url); return u.protocol === 'https:' && SITES.some(r => r.test(u.origin)) ? u.origin : null; } catch { return null; } };

module.exports = function siteWindows({ app, ORIGIN, PARTITION, openExternal }) {
  let siteWin = null, approveWin = null, ready = null, seq = 0;
  const waiting = new Map(); // id -> resolve
  let busy = Promise.resolve(); // one request at a time, like the extension

  function approver() {
    if (approveWin && !approveWin.isDestroyed()) return ready;
    approveWin = new BrowserWindow({ width: 440, height: 680, show: false, resizable: true, minimizable: false, title: 'Parano1d World · Approve', autoHideMenuBar: true, backgroundColor: '#050a07', parent: siteWin || undefined,
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged && process.env.P1W_DEVTOOLS === '1', spellcheck: false, safeDialogs: true, preload: path.join(__dirname, 'approve-preload.js') } });
    approveWin.on('close', e => { if (!app.isQuitting && siteWin && !siteWin.isDestroyed()) { e.preventDefault(); approveWin.hide(); for (const [id, r] of waiting) { r({ error: { code: 4001, message: 'You rejected the request.' } }); waiting.delete(id); } } });
    approveWin.webContents.on('will-navigate', e => e.preventDefault());
    ready = new Promise(r => ipcMain.once('p1w-approve-ready', r));
    approveWin.loadURL(ORIGIN + '/site-approve.html');
    return ready;
  }
  ipcMain.on('p1w-approve-reply', (e, { id, result }) => { if (!approveWin || e.sender !== approveWin.webContents) return; const r = waiting.get(id); if (r) { waiting.delete(id); r(result && typeof result === 'object' ? result : { error: { code: 4900, message: 'No answer' } }); } });
  ipcMain.on('p1w-approve-ui', (e, on) => { if (!approveWin || e.sender !== approveWin.webContents) return; if (on) { approveWin.show(); approveWin.focus(); } else approveWin.hide(); });

  ipcMain.handle('p1w-site-request', async (e, req) => {
    // Only the site window's top frame, on an allowed site; the origin comes from the frame, not the page.
    if (!siteWin || e.sender !== siteWin.webContents || e.senderFrame !== e.sender.mainFrame) return { error: { code: 4100, message: 'Not allowed.' } };
    const origin = allowedOrigin(e.senderFrame.url); if (!origin) return { error: { code: 4100, message: 'Only secure partner sites can connect.' } };
    const method = String(req?.method || ''); if (!METHODS.has(method)) return { error: { code: 4200, message: 'unsupported method' } };
    if (method === 'signIn') return { error: { code: 4200, message: 'Sign-in is not offered by this wallet yet.' } };
    let params = null; try { params = req?.params === undefined ? null : JSON.parse(JSON.stringify(req.params)); } catch { return { error: { code: -32602, message: 'Invalid parameters.' } }; }
    if (JSON.stringify(params || null).length > 4096) return { error: { code: -32602, message: 'Invalid parameters.' } };
    const run = async () => { await approver(); const id = 'r' + (++seq); return new Promise(r => { waiting.set(id, r); approveWin.webContents.send('p1w-approve-request', { id, origin, method, params }); }); };
    const p = busy.then(run, run); busy = p.catch(() => {}); return p;
  });

  function open(url) {
    const origin = allowedOrigin(url); if (!origin) return openExternal(url);
    if (siteWin && !siteWin.isDestroyed()) { siteWin.loadURL(url); siteWin.focus(); return; }
    siteWin = new BrowserWindow({ width: 1280, height: 860, minWidth: 380, minHeight: 600, title: 'Noidium · Parano1d World Wallet', autoHideMenuBar: true, backgroundColor: '#050a07',
      webPreferences: { partition: 'persist:p1w-site-noidium', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false, safeDialogs: true, preload: path.join(__dirname, 'site-preload.js') } });
    const keep = u => !!allowedOrigin(u);
    siteWin.webContents.setWindowOpenHandler(({ url: u }) => { if (keep(u)) siteWin.loadURL(u); else openExternal(u); return { action: 'deny' }; });
    siteWin.webContents.on('will-navigate', (e, u) => { if (!keep(u)) { e.preventDefault(); openExternal(u); } });
    siteWin.webContents.on('will-redirect', (e, u) => { if (!keep(u)) e.preventDefault(); });
    siteWin.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
    siteWin.webContents.session.on('will-download', ev => ev.preventDefault());
    siteWin.on('closed', () => { siteWin = null; if (approveWin && !approveWin.isDestroyed()) { app.isQuitting = true; approveWin.destroy(); app.isQuitting = false; } approveWin = null; });
    siteWin.loadURL(url);
  }
  return { open, allowedOrigin };
};
