'use strict';
/*
 * Motor de la versión web. Hace dentro de un Web Worker lo mismo que el
 * proceso principal de la app de escritorio (vigilar el radar, combinarlo
 * con el modelo, decidir los avisos) y con los mismos módulos; la página
 * habla con él como la app con su proceso principal (ver client.js).
 *
 * Diferencias con la app: los datos se guardan en el navegador (o en ningún
 * sitio, si es un widget insertado en otra web); no hay ubicación por IP,
 * filtro de ecos fijos ni autoevaluación, y los avisos solo llegan con la
 * página abierta.
 */
const { StoreCore } = require('../../src/main/store');
const { RadarSource, RadarHub } = require('../../src/main/radar');
const { OperaSource } = require('../../src/main/opera');
const { WeatherSource } = require('../../src/main/weather');
const { LightningSource } = require('../../src/main/lightning');
const { Monitor } = require('../../src/main/monitor');
const I18N = require('../../src/shared/i18n');

const LOCATE_EVERY_MS = 15 * 60000;
const MAX_M = 20037508.34; // límite de Web Mercator

// Sin cabeceras propias (una como User-Agent obligaría a una consulta CORS
// previa que no todos los servicios aceptan), salvo Range para leer OPERA.
const webFetch = (url, opts = {}) => {
  const range = opts.headers && opts.headers.Range;
  return fetch(url, { headers: range ? { Range: range } : undefined, signal: AbortSignal.timeout(20000) });
};

function readable(raw) {
  try { return !!new StoreCore(raw); } catch (e) { return false; }
}

class WebStore extends StoreCore {
  constructor(raw, onPersist) {
    super(readable(raw) ? raw : null); // datos guardados ilegibles: se empieza de cero
    this.onPersist = onPersist;
  }

  persist(data) { if (this.onPersist) this.onPersist(data); }
}

function validCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
}

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * initial: datos guardados en el navegador; embed: configuración del widget
 * insertado (o null); open: lugar con el que se abrió la página (o null);
 * operaProxy: dirección del intermediario de OPERA (o vacío); post: envía un
 * mensaje a la página.
 */
function createEngine({ initial, embed, open, locale, version, operaProxy, post }) {
  const log = () => {};
  const emit = (event, payload) => post({ type: 'event', event, payload });
  const store = new WebStore(embed ? null : initial, embed ? null : (data) => post({ type: 'persist', data }));
  if (embed) {
    Object.assign(store.data.settings, { language: embed.lang, units: embed.units });
    if (embed.place) store.addLocation(embed.place);
  }
  const getT = () => I18N.make(I18N.resolveLang(store.settings.language, locale));

  // Radar: OPERA a través del intermediario (el almacén de EUMETNET no
  // admite peticiones desde otras webs); sin intermediario, RainViewer.
  const radar = operaProxy
    ? new RadarHub({ opera: new OperaSource({ fetch: webFetch, baseUrl: operaProxy, log }), log })
    : new RadarSource({ fetch: webFetch, userAgent: '', log });
  const weather = new WeatherSource({ fetch: webFetch, userAgent: '', log });
  const lightning = new LightningSource({ fetch: webFetch, userAgent: '', log });
  let last = { statuses: {}, frames: null, error: null };

  function onAlerts(loc, alerts) {
    const snoozed = store.settings.snoozeUntil > Date.now();
    for (const a of alerts) {
      store.addHistory({
        ts: Date.now(), locationId: loc.id, locationName: loc.name,
        type: a.type, title: a.title, body: a.body, silenced: snoozed ? 'snoozed' : null
      });
      if (!snoozed) post({ type: 'notify', title: a.title, body: a.body, tag: `${loc.id}:${a.type}` });
    }
    emit('history', store.data.history);
  }

  const monitor = new Monitor({
    store, radar, weather, lightning, getT, log,
    onUpdate: (payload) => { last = payload; emit('status', payload); },
    onAlerts: embed ? () => {} : onAlerts
  });

  const broadcastLocations = () => emit('locations', { locations: store.data.locations, activeLocationId: store.data.activeLocationId });
  const settingsChanged = () => emit('settings', { settings: store.settings, quietUntil: 0 });

  async function placeName(lat, lon) {
    return (await weather.reverse(lat, lon, getT().lang)) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  }

  function add({ name, lat, lon, follow = false }) {
    const loc = store.addLocation({ name, lat, lon, follow });
    store.setActive(loc.id);
    broadcastLocations();
    monitor.checkNow(loc.id);
    return loc;
  }

  const handlers = {
    getState: () => ({
      settings: store.settings,
      locations: store.data.locations,
      commutes: [],
      activeLocationId: store.data.activeLocationId,
      history: store.data.history,
      statuses: last.statuses,
      frames: last.frames,
      error: last.error,
      systemLocale: locale,
      platform: 'web',
      darkSystem: null,
      quietUntil: 0,
      version,
      embed: embed && { size: embed.size, appUrl: embed.appUrl }
    }),

    updateSettings(patch) {
      if (!patch || typeof patch !== 'object') return store.settings;
      const prevInterval = store.settings.checkIntervalMin;
      store.updateSettings(patch);
      if (store.settings.checkIntervalMin !== prevInterval) monitor.schedule();
      settingsChanged();
      return store.settings;
    },

    async addLocation({ name, lat, lon } = {}) {
      lat = Number(lat); lon = Number(lon);
      if (!validCoords(lat, lon)) throw new Error('Coordenadas no válidas');
      // Nominatim (nombre del lugar) solo cuando el usuario añade un punto del mapa.
      return add({ name: name || await placeName(lat, lon), lat, lon });
    },

    async updateLocation(id, patch) {
      if (!patch || typeof patch !== 'object') return null;
      const moved = patch.lat !== undefined || patch.lon !== undefined;
      const current = store.data.locations.find((l) => l.id === id);
      if (moved && !patch.name && current && !current.customName) {
        const name = await weather.reverse(Number(patch.lat), Number(patch.lon), getT().lang);
        if (name) patch.name = name;
      }
      const loc = store.updateLocation(id, patch);
      if (moved) monitor.forget(id);
      if (moved || (patch.alarm && ('radiusKm' in patch.alarm || 'level' in patch.alarm))) monitor.checkNow(id);
      broadcastLocations();
      return loc;
    },

    removeLocation(id) {
      store.removeLocation(id);
      monitor.forget(id);
      broadcastLocations();
    },

    setActive(id) {
      store.setActive(id);
      broadcastLocations();
      if (!last.statuses[id]) monitor.checkNow(id);
      monitor.syncMap();
    },

    search: (q) => weather.search(String(q || '').slice(0, 100), getT().lang),

    ipLocation() { throw new Error('No disponible en la versión web'); },

    // "Aquí": posición del navegador (la pide la página).
    async follow({ lat, lon } = {}) {
      lat = Number(lat); lon = Number(lon);
      if (!validCoords(lat, lon)) throw new Error('Coordenadas no válidas');
      const t = getT();
      const nameFor = async () => {
        const city = await weather.reverse(lat, lon, t.lang);
        return city ? `${t('ui.here')} · ${city}` : t('ui.here');
      };
      const loc = store.data.locations.find((l) => l.follow);
      if (!loc) return add({ name: await nameFor(), lat, lon, follow: true });
      if (distanceKm(loc, { lat, lon }) < 2) return loc;
      store.updateLocation(loc.id, { lat, lon, name: await nameFor() });
      monitor.relocate(loc.id);
      broadcastLocations();
      monitor.checkNow(loc.id);
      return loc;
    },

    verifyStats: () => ({ loc: null, all: null }),

    async lightningView(q) {
      const b = (q && Array.isArray(q.bbox) ? q.bbox : []).map(Number);
      if (b.length !== 4 || !b.every(Number.isFinite)) return { points: [] };
      const bbox = [Math.max(-MAX_M, b[0]), Math.max(-MAX_M, b[1]), Math.min(MAX_M, b[2]), Math.min(MAX_M, b[3])];
      if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return { points: [] };
      const size = (v) => Math.max(64, Math.min(640, Math.round(Number(v)) || 256));
      try {
        return await lightning.inView(bbox, size(q.width), size(q.height));
      } catch (e) {
        return { points: [], error: e.message };
      }
    },

    radarTile: (q) => (radar.viewTile ? radar.viewTile(q).catch(() => null) : null),

    checkNow() { monitor.checkNow(); },

    testAlert(id) {
      const loc = store.data.locations.find((l) => l.id === id) || store.data.locations[0];
      const t = getT();
      post({ type: 'notify', title: t('notif.test.title'), body: t('notif.test.body', { place: loc ? loc.name : '…' }), tag: 'test' });
    },

    snooze(minutes) {
      store.updateSettings({ snoozeUntil: minutes ? Date.now() + Number(minutes) * 60000 : 0 });
      settingsChanged();
    },

    clearHistory() {
      store.clearHistory();
      emit('history', store.data.history);
    }
  };

  // Página abierta desde un widget (?lat=…&lon=…): ese lugar, nuevo o ya guardado.
  function openPlace() {
    if (!open || !validCoords(open.lat, open.lon)) return;
    const near = store.data.locations.find((l) => distanceKm(l, open) < 1);
    if (near) { store.setActive(near.id); return; }
    store.setActive(store.addLocation({ name: open.name || `${open.lat.toFixed(2)}, ${open.lon.toFixed(2)}`, lat: open.lat, lon: open.lon }).id);
  }

  let running = false;
  return {
    start() {
      openPlace();
      monitor.start();
      running = true;
      if (!embed) {
        // "Aquí" se actualiza al abrir la página y cada 15 min.
        const locate = () => { if (store.data.locations.some((l) => l.follow)) emit('ui', { action: 'locate' }); };
        setTimeout(locate, 3000);
        setInterval(locate, LOCATE_EVERY_MS);
      }
    },
    // Un widget insertado que no se ve no necesita seguir consultando.
    visibility(hidden) {
      if (!embed) return;
      if (hidden && running) { monitor.stop(); running = false; }
      if (!hidden && !running) { monitor.start(); running = true; }
    },
    call(method, args) {
      if (!Object.prototype.hasOwnProperty.call(handlers, method)) throw new Error('Método desconocido: ' + method);
      return handlers[method](...args);
    }
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let engine = null;
  self.onmessage = async (e) => {
    const m = e.data || {};
    if (m.type === 'init') {
      engine = createEngine({ ...m, post: (msg) => self.postMessage(msg) });
      engine.start();
    } else if (engine && m.type === 'visibility') {
      engine.visibility(!!m.hidden);
    } else if (engine && m.type === 'call') {
      try {
        const result = await engine.call(m.method, m.args || []);
        // Las teselas del radar se pasan sin copiarlas.
        self.postMessage({ type: 'reply', id: m.id, result }, result instanceof Uint8Array ? [result.buffer] : []);
      } catch (err) {
        self.postMessage({ type: 'reply', id: m.id, error: String((err && err.message) || err) });
      }
    }
  };
}

module.exports = { createEngine };
