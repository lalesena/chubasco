'use strict';
/*
 * Datos de la app (ajustes, ubicaciones, trayectos, historial). StoreCore no
 * sabe dónde se guardan: la app de escritorio los guarda en un JSON en su
 * carpeta de datos (Store) y la versión web, en el navegador.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ALARM = {
  enabled: true,
  radiusKm: 25,
  level: 'light',
  inRadius: true,
  imminent: true,
  imminentMin: 30,
  minProb: 0.5,       // probabilidad mínima para "llega en X min"
  atLocation: true,
  ended: true,
  model: false,
  lightning: true,    // rayos vistos por satélite…
  lightningKm: 20,    // …a menos de esta distancia
  severe: true        // tormenta fuerte (núcleo muy intenso + rayos): posible granizo
};

const DEFAULTS = {
  version: 1,
  settings: {
    language: 'auto',
    theme: 'auto',
    units: { rate: 'mm', distance: 'km' },
    baseMap: 'auto',
    radarOpacity: 0.8,
    smooth: true,
    showSnow: true,
    showCoverage: false,
    showFuture: true,
    checkIntervalMin: 5,
    dailySummary: { enabled: true, time: '07:30' },
    lastSummaryDay: null,
    showLightning: true,
    push: { enabled: false, server: 'https://ntfy.sh', topic: '' },
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    sound: true,
    launchAtLogin: false,
    startHidden: false,
    closeToTray: true,
    snoozeUntil: 0,
    trayHintShown: false,
    mapView: null,
    // Widget de escritorio: posición en pantalla y ubicación (null = la activa).
    widget: { enabled: false, size: 'medium', onTop: false, locationId: null, x: null, y: null }
  },
  activeLocationId: null,
  locations: [],
  commutes: [],
  history: []
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? merge(base[k], over[k])
      : over[k];
  }
  return out;
}

function load(raw) {
  const data = merge(clone(DEFAULTS), raw);
  data.locations = (data.locations || []).map((l) => ({ ...l, alarm: merge(clone(DEFAULT_ALARM), l.alarm || {}) }));
  // La vista de satélite desapareció (no hay imágenes libres sin clave).
  if (data.settings.baseMap === 'satellite') data.settings.baseMap = 'auto';
  return data;
}

class StoreCore {
  /** raw: datos guardados (o null). Lanza si no tienen la forma esperada. */
  constructor(raw) {
    this.data = raw ? load(raw) : clone(DEFAULTS);
    this.timer = null;
  }

  /** Guarda los datos donde corresponda (lo implementa cada subclase). */
  persist() {}

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.persist(this.data);
  }

  get settings() { return this.data.settings; }

  updateSettings(patch) {
    this.data.settings = merge(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  addLocation({ name, lat, lon, follow = false }) {
    const loc = {
      id: globalThis.crypto.randomUUID(),
      name: String(name || '').slice(0, 80) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
      lat: Number(lat), lon: Number(lon),
      alarm: clone(DEFAULT_ALARM)
    };
    if (follow) loc.follow = true; // "Aquí": sigue la ubicación del equipo
    this.data.locations.push(loc);
    if (!this.data.activeLocationId) this.data.activeLocationId = loc.id;
    this.save();
    return loc;
  }

  updateLocation(id, patch) {
    const loc = this.data.locations.find((l) => l.id === id);
    if (!loc) return null;
    if (patch.name !== undefined) loc.name = String(patch.name).slice(0, 80) || loc.name;
    if (patch.customName !== undefined) loc.customName = !!patch.customName;
    if (patch.lat !== undefined && isFinite(patch.lat)) loc.lat = Number(patch.lat);
    if (patch.lon !== undefined && isFinite(patch.lon)) loc.lon = Number(patch.lon);
    if (patch.alarm) loc.alarm = merge(loc.alarm, patch.alarm);
    if ('dryWatch' in patch) {
      // "Avísame cuando pare": aviso de un solo uso, caduca a las 8 h.
      const w = patch.dryWatch;
      if (w && w.minMin > 0) loc.dryWatch = { minMin: Math.min(240, Number(w.minMin)), since: Date.now(), until: Date.now() + 8 * 3600000 };
      else delete loc.dryWatch;
    }
    this.save();
    return loc;
  }

  removeLocation(id) {
    this.data.locations = this.data.locations.filter((l) => l.id !== id);
    this.data.commutes = this.data.commutes.filter((c) => c.fromId !== id && c.toId !== id);
    if (this.data.activeLocationId === id) {
      this.data.activeLocationId = this.data.locations[0] ? this.data.locations[0].id : null;
    }
    this.save();
  }

  setActive(id) {
    if (this.data.locations.some((l) => l.id === id)) {
      this.data.activeLocationId = id;
      this.save();
    }
  }

  // Trayectos: { id, fromId, toId, time 'HH:MM', days [0..6, 0 = domingo],
  // durationMin, leadMin, onlyIfRain, enabled, lastKey }
  addCommute({ fromId, toId, time, days, durationMin }) {
    const c = {
      id: globalThis.crypto.randomUUID(), fromId, toId, time, days: days.slice().sort(),
      durationMin, leadMin: 30, onlyIfRain: true, enabled: true, lastKey: null
    };
    this.data.commutes.push(c);
    this.save();
    return c;
  }

  updateCommute(id, patch) {
    const c = this.data.commutes.find((x) => x.id === id);
    if (!c) return null;
    for (const k of ['enabled', 'onlyIfRain', 'lastKey', 'time', 'durationMin', 'leadMin', 'days']) if (k in patch) c[k] = patch[k];
    this.save();
    return c;
  }

  removeCommute(id) {
    this.data.commutes = this.data.commutes.filter((c) => c.id !== id);
    this.save();
  }

  addHistory(entry) {
    this.data.history.unshift(entry);
    this.data.history = this.data.history.slice(0, 60);
    this.save();
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }
}

/** Persistencia en un JSON dentro de la carpeta de datos de la app. */
class Store extends StoreCore {
  constructor(dir) {
    const file = path.join(dir, 'chubasco.json');
    let raw = null, bad = false;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      load(raw);
    } catch (e) {
      raw = null;
      bad = e.code !== 'ENOENT';
    }
    if (bad) {
      try { fs.renameSync(file, file + '.bad'); } catch (_) { /* nada */ }
    }
    super(raw);
    this.file = file;
  }

  persist(data) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('No se pudo guardar', e);
    }
  }
}

module.exports = { Store, StoreCore, DEFAULTS, DEFAULT_ALARM };
