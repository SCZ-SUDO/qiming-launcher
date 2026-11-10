'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('qiming', {
  platform: process.platform,
  state: () => invoke('state'),
  setConfig: (patch) => invoke('config:set', patch),
  pickDir: (kind) => invoke('dir:pick', kind),
  openFolder: (target) => invoke('folder:open', target),
  remoteVersions: (force) => invoke('remote:versions', force),
  install: (opts) => invoke('install', opts),
  launch: (opts) => invoke('launch', opts),
  deleteVersion: (opts) => invoke('version:delete', opts),
  detectJava: () => invoke('java:detect'),
  appInfo: () => invoke('app:info'),
  windowControl: (action) => invoke('window:control', action),
  openUrl: (url) => invoke('shell:openUrl', url),
  modsSearch: (opts) => invoke('mods:search', opts),
  modsList: () => invoke('mods:list'),
  modsInstall: (opts) => invoke('mods:install', opts),
  modsImport: () => invoke('mods:import'),
  modsToggle: (opts) => invoke('mods:toggle', opts),
  modsRemove: (opts) => invoke('mods:remove', opts),
  modsReveal: () => invoke('mods:reveal'),
  on: (channel, cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
