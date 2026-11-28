// Preload for the Desktop Wallet's approval window (site-approve.html): carries one request at a time from the app to
// the page and the answer back. Nothing else is exposed.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('p1wDesktopHost', Object.freeze({
  onRequest: cb => ipcRenderer.on('p1w-approve-request', (_e, r) => cb(r)),
  reply: (id, result) => ipcRenderer.send('p1w-approve-reply', { id, result }),
  needUi: on => ipcRenderer.send('p1w-approve-ui', !!on),
  ready: () => ipcRenderer.send('p1w-approve-ready'),
}));
