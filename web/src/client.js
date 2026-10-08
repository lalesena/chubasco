/*
 * Versión web: en la página hace el papel del "preload" de la app de
 * escritorio (window.chubasco, con la misma interfaz) y habla con el motor,
 * que corre en un Web Worker (engine.js). Guarda los datos en el navegador.
 *
 * <html data-mode="embed">: widget para insertar en otras webs. La ubicación
 * y el aspecto van en la dirección (?lat=…&lon=…&name=…&size=…&theme=…&lang=…)
 * y no se guarda nada.
 */
(function () {
  'use strict';
  const EMBED = document.documentElement.dataset.mode === 'embed';
  const KEY = 'chubasco';
  const EVENTS = ['status', 'locations', 'settings', 'history', 'theme', 'ui', 'commutes'];
  const params = new URLSearchParams(location.search);
  const cfg = window.CHUBASCO_WEB || {};

  const coords = () => {
    const lat = parseFloat(params.get('lat')), lon = parseFloat(params.get('lon'));
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  };
  const name = () => (params.get('name') || '').trim().slice(0, 80);

  function embedConfig() {
    const c = coords();
    const app = new URL('./', location.href);
    if (c) {
      app.searchParams.set('lat', c.lat.toFixed(4));
      app.searchParams.set('lon', c.lon.toFixed(4));
      if (name()) app.searchParams.set('name', name());
    }
    const lang = params.get('lang');
    return {
      place: c && { ...c, name: name() || `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}` },
      size: params.get('size') || 'medium',
      lang: lang === 'es' || lang === 'en' ? lang : 'auto',
      units: params.get('units') === 'imperial' ? { rate: 'in', distance: 'mi' } : { rate: 'mm', distance: 'km' },
      appUrl: app.href
    };
  }

  // Versión completa abierta desde un widget: ese lugar, y la dirección limpia.
  function openPlace() {
    const c = coords();
    if (!c) return null;
    history.replaceState(null, '', location.pathname);
    return { ...c, name: name() };
  }

  function readSaved() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }
  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* almacenamiento lleno o bloqueado */ }
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  // Avisos del navegador: solo con permiso y mientras la página está abierta.
  function notify(m) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(m.title, { body: m.body, tag: m.tag, icon: 'icon-192.png' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* p. ej. Chrome en Android solo los admite desde un service worker */ }
  }

  // Ya desde el principio: así no asoman las partes que solo tiene la app de escritorio.
  document.body.classList.add('platform-web');
  const embed = EMBED ? embedConfig() : null;
  if (EMBED) applyTheme(params.get('theme'));

  const worker = new Worker('engine.js');
  const pending = new Map();
  const listeners = new Map(EVENTS.map((e) => [e, new Set()]));
  let seq = 0;

  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'reply') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if ('error' in m) p.reject(new Error(m.error)); else p.resolve(m.result);
    } else if (m.type === 'event') {
      if (m.event === 'settings' && !EMBED) applyTheme(m.payload.settings.theme);
      for (const cb of listeners.get(m.event) || []) cb(m.payload);
    } else if (m.type === 'persist') {
      save(m.data);
    } else if (m.type === 'notify') {
      notify(m);
    }
  };
  worker.onerror = (e) => console.error('Chubasco: el motor no arrancó', e.message);
  worker.postMessage({
    type: 'init',
    initial: EMBED ? null : readSaved(),
    embed,
    open: EMBED ? null : openPlace(),
    locale: navigator.language || 'es',
    version: cfg.version || '',
    operaProxy: cfg.operaProxy || ''
  });
  if (EMBED) {
    document.addEventListener('visibilitychange', () => worker.postMessage({ type: 'visibility', hidden: document.hidden }));
  }

  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'call', id, method, args });
  });
  const none = () => Promise.resolve(null);

  window.chubasco = {
    getState: () => call('getState').then((st) => { if (!EMBED) applyTheme(st.settings.theme); return st; }),
    updateSettings: (patch) => call('updateSettings', patch),
    addLocation: (loc) => call('addLocation', loc),
    updateLocation: (id, patch) => call('updateLocation', id, patch),
    removeLocation: (id) => call('removeLocation', id),
    setActive: (id) => call('setActive', id),
    search: (q) => call('search', q),
    ipLocation: () => call('ipLocation'),
    follow: (pos) => call('follow', pos),
    verifyStats: (id) => call('verifyStats', id),
    lightningView: (q) => call('lightningView', q),
    radarTile: (q) => call('radarTile', q),
    // Lo publica la propia web cada hora (scripts/agua/datos.mjs).
    agua: () => fetch('agua/agua.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    checkNow: () => call('checkNow'),
    async testAlert(id) {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      return call('testAlert', id);
    },
    snooze: (minutes) => call('snooze', minutes),
    clearHistory: () => call('clearHistory'),
    copy: (text) => navigator.clipboard.writeText(String(text)),
    openExternal: (url) => { if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener'); return none(); },
    showMain: () => { if (embed) window.open(embed.appUrl, '_blank', 'noopener'); return none(); },
    // Solo existen en la app de escritorio.
    dryWatch: none, miniResize: none, miniHide: none, pushTest: none, widgetMenu: none, widgetDrag: () => {},
    addCommute: none, updateCommute: none, removeCommute: none, checkCommute: none,
    on(event, cb) {
      if (!listeners.has(event)) throw new Error('Evento desconocido: ' + event);
      listeners.get(event).add(cb);
      return () => listeners.get(event).delete(cb);
    }
  };
})();
