// Background mining service for Mac and Linux (see boot.js). It loads the mining dashboard that ships inside this
// app (rig-companion/, covered by the app's own pinned SHA-256), with its own browser profile and no window.
'use strict';
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const { app } = require('electron');
const { miningPaths } = require('./mining-paths.js');

exports.run = function run() {
  const P = miningPaths(app.getPath('home'), process.platform, process.env);
  fs.mkdirSync(P.base, { recursive: true, mode: 0o700 });
  app.setPath('userData', path.join(P.base, 'service-profile')); // never shares the wallet window's profile
  app.disableHardwareAcceleration();
  if (app.dock) app.dock.hide();
  app.on('window-all-closed', () => {}); // there are no windows; keep running
  let svc = {}; try { svc = JSON.parse(fs.readFileSync(P.serviceFile, 'utf8')); } catch {}
  // Fixed arguments for the dashboard: its data folder and the node's own folder. Nothing comes from a web page.
  process.argv.push('--data', P.rigData, '--core-data', P.chain, '--core-p2p', svc.p2p === 'open' ? 'open' : 'local');
  let build = 'unknown'; try { build = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).build || 'unknown'; } catch {}
  app.whenReady()
    .then(() => import(pathToFileURL(path.join(__dirname, 'rig-companion', 'agent.mjs')).href))
    .then(() => fs.writeFileSync(P.runningFile, JSON.stringify({ build, core: svc.core || null, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 }))
    .catch(() => app.exit(1));
};
