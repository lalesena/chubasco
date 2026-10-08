'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['status', 'locations', 'settings', 'history', 'theme', 'ui', 'commutes'];

contextBridge.exposeInMainWorld('chubasco', {
  getState: () => ipcRenderer.invoke('state:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  addLocation: (loc) => ipcRenderer.invoke('location:add', loc),
  updateLocation: (id, patch) => ipcRenderer.invoke('location:update', { id, patch }),
  removeLocation: (id) => ipcRenderer.invoke('location:remove', id),
  setActive: (id) => ipcRenderer.invoke('location:setActive', id),
  search: (q) => ipcRenderer.invoke('geo:search', q),
  ipLocation: () => ipcRenderer.invoke('geo:ip'),
  follow: (pos) => ipcRenderer.invoke('location:follow', pos),
  verifyStats: (id) => ipcRenderer.invoke('verify:get', id),
  dryWatch: (id, minMin) => ipcRenderer.invoke('location:dryWatch', { id, minMin }),
  lightningView: (q) => ipcRenderer.invoke('lightning:view', q),
  radarTile: (q) => ipcRenderer.invoke('radar:tile', q),
  agua: (file) => ipcRenderer.invoke('agua:get', file),
  miniResize: (h) => ipcRenderer.invoke('mini:resize', h),
  miniHide: () => ipcRenderer.invoke('mini:hide'),
  showMain: (id) => ipcRenderer.invoke('app:showMain', id),
  widgetMenu: () => ipcRenderer.invoke('widget:menu'),
  widgetDrag: (phase) => ipcRenderer.send('widget:drag', phase),
  pushTest: () => ipcRenderer.invoke('push:test'),
  addCommute: (c) => ipcRenderer.invoke('commute:add', c),
  updateCommute: (id, patch) => ipcRenderer.invoke('commute:update', { id, patch }),
  removeCommute: (id) => ipcRenderer.invoke('commute:remove', id),
  checkCommute: (id) => ipcRenderer.invoke('commute:check', id),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  checkNow: () => ipcRenderer.invoke('monitor:check'),
  testAlert: (id) => ipcRenderer.invoke('alerts:test', id),
  snooze: (minutes) => ipcRenderer.invoke('alerts:snooze', minutes),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  on: (event, cb) => {
    if (!EVENTS.includes(event)) throw new Error('Evento desconocido: ' + event);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(event, fn);
    return () => ipcRenderer.removeListener(event, fn);
  }
});
