'use strict';
/*
 * Bucle de vigilancia: analiza el radar de cada ubicación en cuanto sale un
 * fotograma nuevo (se mira cada minuto) y, como respaldo, cada N minutos;
 * refresca el modelo, decide avisos, alimenta la autoverificación y publica
 * el estado.
 */
const P = require('../shared/palette');
const { evaluate, freshState } = require('./alerts');
const { calibrateRadar } = require('./verify');

const MODEL_TTL = 15 * 60000;
const WATCH_MS = 60000;

class Monitor {
  constructor({ store, radar, weather, lightning = null, getT, onUpdate, onAlerts, verifier = null, log = () => {} }) {
    this.store = store;
    this.radar = radar;
    this.weather = weather;
    this.lightning = lightning;
    this.verifier = verifier;
    this.getT = getT;
    this.onUpdate = onUpdate;
    this.onAlerts = onAlerts;
    this.log = log;
    this.status = new Map();      // id -> { radar, model }
    this.alertState = new Map();  // id -> estado del motor de avisos
    this.timer = null;
    this.running = false;
    this.pending = false;
    this.frames = null;
    this.lastError = null;
    this.gen = new Map();         // id -> contador; cambia al mover/borrar
    this.runningSince = 0;
    this.lastFrameAnalyzed = 0;  // hora (s) del último fotograma analizado
    this.lastTriggered = 0;      // último fotograma que disparó una comprobación
    this.watchTimer = null;
  }

  start() {
    this.schedule(1500);
    this.watchTimer = setInterval(() => this.watch(), WATCH_MS);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.watchTimer);
    this.timer = null;
    this.watchTimer = null;
  }

  /** ¿Hay fotograma nuevo? Entonces se analiza ya, sin esperar al intervalo. */
  async watch() {
    if (this.running || !this.store.data.locations.length) return;
    try {
      const maps = await this.radar.getMaps(true);
      const latest = maps.frames[maps.frames.length - 1].time;
      // Una sola vez por fotograma: si el análisis falla, reintenta el ciclo normal.
      if (latest > this.lastFrameAnalyzed && latest !== this.lastTriggered) {
        this.lastTriggered = latest;
        this.log('watch', 'fotograma nuevo', new Date(latest * 1000).toISOString());
        await this.tick();
      }
    } catch (e) {
      this.log('watch', e.message);
    }
  }

  schedule(ms) {
    clearTimeout(this.timer);
    const interval = Math.max(2, this.store.settings.checkIntervalMin || 5) * 60000;
    this.timer = setTimeout(() => this.tick(), ms === undefined ? interval : ms);
  }

  /** Comprobación inmediata (opcionalmente solo de una ubicación). */
  checkNow(onlyId) {
    if (onlyId) return this.checkLocation(onlyId, { evaluateAlerts: false }).then(() => this.emit());
    return this.tick();
  }

  forget(id) {
    this.status.delete(id);
    this.alertState.delete(id);
    this.gen.set(id, (this.gen.get(id) || 0) + 1);
  }

  /** "Aquí" se ha movido: datos nuevos, pero sin olvidar qué se ha avisado ya. */
  relocate(id) {
    this.status.delete(id);
    this.gen.set(id, (this.gen.get(id) || 0) + 1);
  }

  /** Otra ubicación activa: puede que el mapa tenga que cambiar de fuente. */
  async syncMap() {
    const before = this.frames;
    await this.refreshFrames(false);
    if (this.frames !== before) this.emit();
  }

  async refreshFrames(force) {
    try {
      const maps = await this.radar.getMaps(force);
      this.frames = maps;
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      this.log('maps', e.message);
    }
    return this.frames;
  }

  async tick() {
    // Vigilante: si una comprobación lleva demasiado tiempo, se da por perdida.
    if (this.running && Date.now() - this.runningSince > 4 * 60000) {
      this.log('tick', 'comprobación colgada; se reinicia');
      this.running = false;
    }
    if (this.running) { this.pending = true; return; }
    this.running = true;
    this.runningSince = Date.now();
    try {
      await this.refreshFrames(true);
      const locs = this.store.data.locations.slice();
      // Primero la ubicación activa, para que la interfaz responda antes.
      locs.sort((a, b) => (a.id === this.store.data.activeLocationId ? -1 : b.id === this.store.data.activeLocationId ? 1 : 0));
      let analyzed = 0;
      for (const loc of locs) {
        await this.checkLocation(loc.id, { evaluateAlerts: true });
        const r = this.status.get(loc.id) && this.status.get(loc.id).radar;
        if (r && r.ok) analyzed = Math.max(analyzed, r.frameTime);
        this.emit();
      }
      if (analyzed) this.lastFrameAnalyzed = analyzed;
    } catch (e) {
      this.log('tick', e.stack || e.message);
    } finally {
      this.running = false;
      this.emit();
      if (this.pending) { this.pending = false; this.schedule(500); } else this.schedule();
    }
  }

  async checkLocation(id, { evaluateAlerts }) {
    const loc = this.store.data.locations.find((l) => l.id === id);
    if (!loc) return;
    const gen = this.gen.get(id) || 0;
    const stillValid = () => (this.gen.get(id) || 0) === gen && this.store.data.locations.includes(loc);
    const prev = this.status.get(id) || {};
    const next = { ...prev };
    const thresholdDbz = P.LEVELS[loc.alarm.level || 'light'];

    try {
      if (!this.frames) await this.refreshFrames(false);
      const res = await this.radar.analyze(loc, { thresholdDbz, alarmRadiusKm: loc.alarm.radiusKm });
      next.radar = res;
      // El mapa enseña la fuente de la ubicación activa (OPERA o RainViewer).
      const shown = this.frames && this.frames.source;
      if (res.source && shown && res.source !== shown && id === this.store.data.activeLocationId) await this.refreshFrames(false);
    } catch (e) {
      if (e.code !== 'noCoverage') this.log('radar', loc.name, e.message);
      next.radar = { ok: false, error: e.message, code: e.code || null, checkedAt: Date.now() };
    }

    const modelKey = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    if (!prev.model || !prev.model.ok || prev.modelKey !== modelKey || Date.now() - prev.model.updatedAt > MODEL_TTL) {
      try {
        next.model = await this.weather.forecast(loc.lat, loc.lon);
        next.modelKey = modelKey;
      } catch (e) {
        this.log('model', loc.name, e.message);
        if (!prev.model || prev.modelKey !== modelKey) next.model = { ok: false, error: e.message };
      }
    }
    if (this.lightning) {
      try {
        next.lightning = await this.lightning.around(loc.lat, loc.lon, Math.max(60, (loc.alarm.lightningKm || 20) * 2));
      } catch (e) {
        this.log('lightning', loc.name, e.message);
        next.lightning = { ok: false, error: e.message };
      }
    }

    // Si la ubicación se movió o borró mientras tanto, el resultado ya no vale.
    if (!stillValid()) return;
    if (this.verifier && next.radar && next.radar.ok && next.radar !== prev.radar) {
      // La autoevaluación usa la previsión sin calibrar; la app, la calibrada.
      this.verifier.ingest(id, thresholdDbz, next.radar, next.model);
      next.radar = calibrateRadar(next.radar, this.verifier.calibration());
    }
    this.status.set(id, next);

    if (evaluateAlerts) {
      const settings = this.store.settings;
      const { alerts, state } = evaluate({
        loc, status: next, state: this.alertState.get(id) || freshState(),
        now: Date.now(), settings, t: this.getT()
      });
      this.alertState.set(id, state);
      if (alerts.length) this.onAlerts(loc, alerts);
    }
  }

  snapshot() {
    const out = {};
    for (const [id, st] of this.status) out[id] = { radar: st.radar || null, model: st.model || null, lightning: st.lightning || null };
    return out;
  }

  emit() {
    this.onUpdate({ statuses: this.snapshot(), frames: this.frames, error: this.lastError, running: this.running });
  }
}

module.exports = { Monitor };
