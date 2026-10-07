'use strict';
/*
 * Autoverificación: cada previsión del radar se guarda y, cuando llegan los
 * fotogramas siguientes, se compara con lo que el radar ve de verdad en la
 * ubicación. Así se sabe cuánto acierta la app en cada sitio y hay datos para
 * ajustar los umbrales (verify-log.jsonl guarda cada caso).
 *
 * Medidas (últimos 30 días):
 *  - a 10/20/30/60 min: lluvia anticipada (POD), falsas alarmas (FAR) y mejora
 *    del CSI sobre la referencia "seguirá igual" (persistencia);
 *  - error de la hora de llegada cuando empieza a llover;
 *  - episodios de aviso de llegada (≤ 30 min): acertados, sin aviso, en falso.
 */
const fs = require('fs');
const path = require('path');

const F = require('../shared/forecast');
const P = require('../shared/palette');

const LEADS = [10, 20, 30, 60];
const KEEP_DAYS = 30;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Calibración automática: se activa con datos suficientes (todas las ubicaciones juntas).
const BINS = 5;
const CAL_MIN_N = 300;       // comparaciones por plazo
const CAL_MIN_EVENTS = 30;   // de ellas, con lluvia observada
const CAL_SHRINK = 20;       // "casos virtuales" que tiran hacia no corregir

function dayKey(ft) {
  const d = new Date(ft * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay() {
  const leads = {};
  for (const L of LEADS) {
    leads[L] = {
      n: 0, hit: 0, miss: 0, fa: 0, cn: 0, brier: 0, pHit: 0, pMiss: 0, pFa: 0,
      rb: new Array(BINS).fill(0), rw: new Array(BINS).fill(0), // fiabilidad: casos y lluvias por tramo de probabilidad
      mN: 0, wa: 0, wb: 0                                          // radar frente a modelo (peso óptimo)
    };
  }
  return { frames: 0, leads, eta: { n: 0, abs: 0, bias: 0 }, ep: { hit: 0, missed: 0, fa: 0, leadSum: 0 } };
}

function freshState() {
  return { lastFt: 0, lastWet: null, pending: [], run: null, thr: null };
}

class Verifier {
  constructor(dir, { log = () => {} } = {}) {
    this.file = path.join(dir, 'verify.json');
    this.logFile = path.join(dir, 'verify-log.jsonl');
    this.log = log;
    this.data = { version: 1, locs: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.locs) this.data = raw;
    } catch (e) {
      if (e.code !== 'ENOENT') log('verify', e.message);
    }
    this.timer = null;
    this.lines = [];
  }

  loc(id) {
    if (!this.data.locs[id]) this.data.locs[id] = { days: {}, st: freshState() };
    return this.data.locs[id];
  }

  /** Ubicación borrada o movida: sus datos ya no valen. */
  forget(id) {
    delete this.data.locs[id];
    this.saveSoon();
  }

  /**
   * `radar`: resultado (sin calibrar) de RadarSource.analyze; `model`: la
   * previsión del modelo en ese momento (para aprender cuánto fiarse de cada uno).
   */
  ingest(id, thresholdDbz, radar, model = null) {
    if (!radar || !radar.ok || !radar.atLocation || !radar.atLocation.hasData) return;
    const L = this.loc(id);
    const ft = radar.frameTime;
    let st = L.st;
    if (!(ft > st.lastFt)) return;
    // Umbral cambiado o hueco de más de una hora: lo pendiente ya no se puede comparar.
    if ((st.thr !== null && st.thr !== thresholdDbz) || (st.lastFt && ft - st.lastFt > 3600)) st = L.st = freshState();
    st.thr = thresholdDbz;

    const dbz = radar.atLocation.dbz;
    const obs = dbz !== null && dbz !== undefined && dbz >= thresholdDbz;
    const key = dayKey(ft);
    const day = L.days[key] || (L.days[key] = emptyDay());
    day.frames++;

    // 1. Previsiones anteriores que vencen con este fotograma.
    for (const pr of st.pending) {
      const lead = Math.round((ft - pr.ft) / 60);
      for (const Ld of LEADS) {
        const p = pr.p[Ld];
        if (Math.abs(lead - Ld) > 2 || p === null || p === undefined || pr.done[Ld]) continue;
        pr.done[Ld] = 1;
        const c = day.leads[Ld];
        const yes = p >= 0.5;
        c.n++;
        c.brier += (p - (obs ? 1 : 0)) ** 2;
        if (yes && obs) c.hit++; else if (obs) c.miss++; else if (yes) c.fa++; else c.cn++;
        // Referencia "seguirá igual": lo que había cuando se hizo la previsión.
        if (pr.wet0 && obs) c.pHit++; else if (obs) c.pMiss++; else if (pr.wet0) c.pFa++;
        if (!c.rb) { c.rb = new Array(BINS).fill(0); c.rw = new Array(BINS).fill(0); c.mN = 0; c.wa = 0; c.wb = 0; }
        const b = Math.min(BINS - 1, Math.floor(p * BINS));
        c.rb[b]++;
        if (obs) c.rw[b]++;
        const pm = pr.pm ? pr.pm[Ld] : null;
        if (pm !== null && pm !== undefined) {
          const o = obs ? 1 : 0;
          c.mN++;
          c.wa += (p - pm) ** 2;
          c.wb += (pm - o) * (pm - p);
        }
      }
    }

    // 2. Empieza a llover: ¿cuánto se equivocó la hora de llegada prevista?
    if (obs && st.lastWet === false) {
      for (const pr of st.pending) {
        if (pr.wet0 || pr.eta === null) continue;
        const leadMin = (ft - pr.ft) / 60;
        if (leadMin < 10 || leadMin > 60) continue;
        const err = (pr.ft + pr.eta * 60 - ft) / 60;
        day.eta.n++;
        day.eta.abs += Math.abs(err);
        day.eta.bias += err;
      }
    }

    // 3. Episodios de aviso de llegada (≤ 30 min), como los que notifica la app.
    const eta = radar.nowcast && radar.nowcast.etaMin > 0 ? radar.nowcast.etaMin : null;
    if (obs) {
      if (st.run) { day.ep.hit++; day.ep.leadSum += (ft - st.run.start) / 60; st.run = null; } else if (st.lastWet === false) day.ep.missed++;
    } else {
      if (st.run && ft > st.run.deadline) { day.ep.fa++; st.run = null; }
      if (eta !== null && eta <= 30) {
        const deadline = ft + (eta + 20) * 60;
        if (st.run) st.run.deadline = Math.max(st.run.deadline, deadline);
        else st.run = { start: ft, deadline };
      }
    }

    // 4. Nueva previsión pendiente.
    const p = {};
    const series = (radar.nowcast && radar.nowcast.series) || [];
    for (const Ld of LEADS) {
      const s = series.find((x) => x.t === Ld);
      p[Ld] = s && s.known && s.p !== null && s.p !== undefined ? s.p : null;
    }
    let pm = null;
    if (model && model.ok) {
      pm = {};
      for (const Ld of LEADS) pm[Ld] = F.modelProb(model, (ft + Ld * 60) * 1000, P.dbzToRate(thresholdDbz, P.KIND_RAIN));
    }
    st.pending.push({ ft, p, pm, eta: obs ? null : eta, wet0: obs, done: {} });
    this.cal = null; // se recalcula cuando se pida
    st.pending = st.pending.filter((pr) => ft - pr.ft <= 65 * 60);
    st.lastFt = ft;
    st.lastWet = obs;

    this.lines.push(JSON.stringify({ loc: id, ft, thr: thresholdDbz, dbz: dbz === undefined ? null : dbz, p10: p[10], p30: p[30], p60: p[60], eta }));
    const oldest = dayKey(ft - KEEP_DAYS * 86400);
    for (const k of Object.keys(L.days)) if (k < oldest) delete L.days[k];
    this.saveSoon();
  }

  /** Estadísticas agregadas de una ubicación (o de todas con id = null). */
  stats(id) {
    const ids = id ? [id] : Object.keys(this.data.locs);
    const agg = emptyDay();
    let since = null;
    for (const i of ids) {
      const L = this.data.locs[i];
      if (!L) continue;
      for (const [k, d] of Object.entries(L.days)) {
        if (!since || k < since) since = k;
        agg.frames += d.frames;
        for (const Ld of LEADS) {
          const a = agg.leads[Ld], x = d.leads[Ld];
          for (const f of Object.keys(a)) {
            if (Array.isArray(a[f])) a[f].forEach((_, i) => { a[f][i] += (x[f] && x[f][i]) || 0; });
            else a[f] += x[f] || 0;
          }
        }
        for (const f of Object.keys(agg.eta)) agg.eta[f] += d.eta[f] || 0;
        for (const f of Object.keys(agg.ep)) agg.ep[f] += d.ep[f] || 0;
      }
    }
    const ratio = (a, b) => (b ? a / b : null);
    const leads = {};
    for (const Ld of LEADS) {
      const c = agg.leads[Ld];
      const csi = ratio(c.hit, c.hit + c.miss + c.fa);
      const pcsi = ratio(c.pHit, c.pHit + c.pMiss + c.pFa);
      leads[Ld] = {
        n: c.n, events: c.hit + c.miss,
        pod: ratio(c.hit, c.hit + c.miss), far: ratio(c.fa, c.hit + c.fa), csi,
        skill: csi !== null && pcsi !== null ? csi - pcsi : null,
        brier: ratio(c.brier, c.n)
      };
    }
    const e = agg.eta, ep = agg.ep;
    return {
      frames: agg.frames, since, leads,
      eta: e.n ? { n: e.n, mae: e.abs / e.n, bias: e.bias / e.n } : null,
      episodes: { hit: ep.hit, missed: ep.missed, fa: ep.fa, lead: ep.hit ? ep.leadSum / ep.hit : null },
      calibration: this.calibration()
    };
  }

  /**
   * Calibración aprendida con todas las ubicaciones:
   *  - por plazo, tabla "prob. dicha → frecuencia observada" (encogida hacia
   *    no corregir y obligada a ser creciente);
   *  - por plazo, peso óptimo del radar frente al modelo (mínimo error cuadrático).
   */
  calibration() {
    if (this.cal) return this.cal;
    const sum = emptyDay();
    for (const L of Object.values(this.data.locs)) {
      for (const d of Object.values(L.days)) {
        for (const Ld of LEADS) {
          const x = d.leads[Ld], a = sum.leads[Ld];
          if (!x || !x.rb) continue;
          for (let i = 0; i < BINS; i++) { a.rb[i] += x.rb[i]; a.rw[i] += x.rw[i]; }
          a.mN += x.mN; a.wa += x.wa; a.wb += x.wb;
        }
      }
    }
    const leads = {};
    let any = false;
    for (const Ld of LEADS) {
      const a = sum.leads[Ld];
      const n = a.rb.reduce((s, v) => s + v, 0), events = a.rw.reduce((s, v) => s + v, 0);
      const map = calibrationMap(a.rb, a.rw);
      const active = n >= CAL_MIN_N && events >= CAL_MIN_EVENTS;
      const w = a.wa > 1 ? Math.max(0, Math.min(1, a.wb / a.wa)) : null;
      const wActive = active && a.mN >= CAL_MIN_N && w !== null;
      leads[Ld] = { n, events, active, map, w, wActive };
      if (active) any = true;
    }
    this.cal = { active: any, leads, minN: CAL_MIN_N, minEvents: CAL_MIN_EVENTS };
    // Ejemplo legible: qué frecuencia real corresponde a un "70 %" del radar.
    for (const Ld of LEADS) leads[Ld].at70 = calibrateP(0.7, Ld, { leads: { [Ld]: { ...leads[Ld], active: true } } });
    return this.cal;
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 5000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
      fs.renameSync(this.file + '.tmp', this.file);
      if (this.lines.length) {
        try { if (fs.statSync(this.logFile).size > MAX_LOG_BYTES) fs.renameSync(this.logFile, this.logFile + '.1'); } catch (_) { /* aún no existe */ }
        fs.appendFileSync(this.logFile, this.lines.join('\n') + '\n');
        this.lines = [];
      }
    } catch (e) {
      this.log('verify', e.message);
    }
  }
}

/** Frecuencia observada por tramo, encogida hacia el centro del tramo y creciente (PAV). */
function calibrationMap(rb, rw) {
  const blocks = [];
  for (let i = 0; i < BINS; i++) {
    const center = (i + 0.5) / BINS;
    const n = rb[i] + CAL_SHRINK;
    blocks.push({ w: n, v: (rw[i] + CAL_SHRINK * center) / n, count: 1 });
    // Une tramos vecinos mientras la frecuencia baje (debe crecer con la probabilidad).
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop(), a = blocks.pop();
      blocks.push({ w: a.w + b.w, v: (a.v * a.w + b.v * b.w) / (a.w + b.w), count: a.count + b.count });
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.count; k++) out.push(b.v);
  return out;
}

/** Aplica la calibración a una probabilidad del radar a `lead` min del fotograma. */
function calibrateP(p, lead, cal) {
  if (p === null || p === undefined || !cal || lead <= 0) return p;
  const Ld = lead <= 15 ? 10 : lead <= 25 ? 20 : lead <= 45 ? 30 : 60;
  const c = cal.leads[Ld];
  if (!c || !c.active) return p;
  // Interpolación lineal entre los centros de los tramos.
  const x = p * BINS - 0.5;
  if (x <= 0) return c.map[0];
  if (x >= BINS - 1) return c.map[BINS - 1];
  const i = Math.floor(x), f = x - i;
  return c.map[i] * (1 - f) + c.map[i + 1] * f;
}

/** Copia del resultado del radar con probabilidades calibradas y pesos aprendidos. */
function calibrateRadar(r, cal) {
  if (!r || !r.ok || !cal || !cal.active) return r;
  const fix = (nc) => nc && { ...nc, series: nc.series.map((s) => ({ ...s, pRaw: s.p, p: calibrateP(s.p, s.t, cal) })) };
  const weights = {};
  for (const Ld of LEADS) if (cal.leads[Ld].wActive) weights[Ld] = cal.leads[Ld].w;
  return {
    ...r,
    nowcast: fix(r.nowcast),
    points: (r.points || []).map((p) => ({ ...p, nowcast: fix(p.nowcast) })),
    calib: Object.keys(weights).length ? { weights } : null
  };
}

module.exports = { Verifier, LEADS, calibrationMap, calibrateP, calibrateRadar };
