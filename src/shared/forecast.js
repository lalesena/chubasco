/*
 * Previsión combinada para una ubicación: radar extrapolado al principio y
 * modelo (Open-Meteo) después, con un paso gradual entre ambos. De aquí salen
 * la hora de llegada, la de fin y la "ventana seca".
 *
 * UMD: window.RA_FORECAST en la interfaz.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./palette'));
  else root.RA_FORECAST = factory(root.RA_PALETTE);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const MIN = 60000;
  const STALE_MIN = 35;

  // Calibración (ajustable con los datos de la sección «Precisión»):
  const RADAR_FULL_MIN = 20;  // hasta aquí manda solo el radar
  const RADAR_FADE_MIN = 40;  // luego pierde peso en 40 + 60·confianza min
  const MODEL_INSTANT = 0.7;  // prob. horaria del modelo (>0,1 mm en la hora) → en un instante

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /**
   * Peso del radar según cuánto se extrapola (min desde el fotograma). Con
   * calibración aprendida (`weights` por plazo: 10, 20, 30, 60 min) se usa
   * esa curva; más allá de 60 min baja hasta 0 a los 120.
   */
  function radarWeight(lead, confidence, weights) {
    if (weights && Object.keys(weights).length) {
      const pts = [[0, 1]];
      for (const L of [10, 20, 30, 60]) if (weights[L] !== undefined) pts.push([L, weights[L]]);
      pts.push([120, 0]);
      for (let i = 1; i < pts.length; i++) {
        if (lead <= pts[i][0]) {
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
          return clamp(y0 + ((y1 - y0) * (lead - x0)) / (x1 - x0), 0, 1);
        }
      }
      return 0;
    }
    if (lead <= RADAR_FULL_MIN) return 1;
    const span = RADAR_FADE_MIN + 60 * clamp(confidence || 0, 0, 1);
    return clamp(1 - (lead - RADAR_FULL_MIN) / span, 0, 1);
  }

  function radarAt(r, ts, thr) {
    const nc = r.nowcast;
    if (!nc || !nc.series || !nc.series.length) return null;
    const step = nc.stepMin || 5;
    const lead = (ts - r.frameTime * 1000) / MIN;
    const s = nc.series[Math.round(lead / step)];
    if (!s || !s.known) return null;
    const p = s.p !== undefined && s.p !== null ? s.p : s.dbz !== null && s.dbz >= thr ? 1 : 0;
    return { lead, p, rate: s.rate || 0, kind: s.kind || P.KIND_RAIN };
  }

  function modelAt(m, ts, thrRate) {
    if (!m) return null;
    const slot = (m.minutely || []).find((x) => x.t - 15 * MIN < ts && ts <= x.t);
    const hour = (m.hourly || []).find((x) => x.t - 60 * MIN < ts && ts <= x.t);
    let rate = null, snow = false;
    if (slot && slot.precip !== null) { rate = slot.precip * 4; snow = (slot.snow || 0) > 0; }
    else if (hour && hour.precip !== null) rate = hour.precip;
    if (rate === null) return null;
    let p;
    if (hour && hour.prob !== null && hour.prob !== undefined) p = (hour.prob / 100) * MODEL_INSTANT;
    else p = rate >= thrRate ? 0.6 : rate > 0 ? 0.25 : 0.03;
    return { p, rate, kind: snow ? P.KIND_SNOW : P.KIND_RAIN };
  }

  /** Primer índice ≥ from donde la serie deja de cumplir `wet` dos pasos seguidos. */
  function stopIndex(series, from, pThr) {
    let run = 0;
    for (let k = from; k < series.length; k++) {
      const s = series[k];
      if (!s.known) return -1;
      if (s.p < pThr) { run++; if (run >= 2) return k - 1; } else run = 0;
    }
    return -1;
  }

  function wetIndex(series, from, pThr) {
    for (let k = from; k < series.length; k++) {
      if (!series[k].known) return -1;
      if (series[k].p >= pThr) return k;
    }
    return -1;
  }

  function lastKnown(series) {
    let k = 0;
    while (k + 1 < series.length && series[k + 1].known) k++;
    return series[k] && series[k].known ? series[k].ts : null;
  }

  /**
   * Ventana seca: si llueve, cuándo para y hasta cuándo dura la pausa; si no
   * llueve, hasta cuándo sigue seco. `beyond` = sin lluvia hasta el final de
   * lo que se sabe (horizonTs).
   */
  function dryWindow(series, wetNow, pThr) {
    if (!series || series.length < 2 || !series[1].known) return null;
    const horizonTs = lastKnown(series);
    if (wetNow) {
      const stop = stopIndex(series, 1, pThr);
      if (stop < 0) return { state: 'wet', stopsAt: null, dryUntil: null, beyond: false, horizonTs };
      const next = wetIndex(series, stop + 1, pThr);
      return { state: 'wet', stopsAt: series[stop].ts, dryUntil: next > 0 ? series[next].ts : null, beyond: next < 0, horizonTs };
    }
    const next = wetIndex(series, 1, pThr);
    return { state: 'dry', stopsAt: null, dryUntil: next > 0 ? series[next].ts : null, beyond: next < 0, horizonTs };
  }

  /**
   * Serie cada `stepMin` desde ahora: { ts, p, rate, dbz, kind, known, src, w }.
   * Devuelve también eta {min, early, late, p}, end {min}, dry y pMax.
   */
  function blend(status, loc, { now = Date.now(), horizonMin = 360, stepMin = 5 } = {}) {
    const a = (loc && loc.alarm) || {};
    const thr = P.LEVELS[a.level || 'light'];
    const thrRate = P.dbzToRate(thr, P.KIND_RAIN);
    const pThr = a.minProb || 0.5;
    const r0 = status && status.radar && status.radar.ok ? status.radar : null;
    const r = r0 && (now - r0.frameTime * 1000) / MIN <= STALE_MIN ? r0 : null;
    const m = status && status.model && status.model.ok ? status.model : null;
    if (!r && !m) return null;
    const conf = r && r.motion ? r.motion.confidence : 0;

    const series = [];
    let radarSteps = 0;
    for (let k = 0; k * stepMin <= horizonMin; k++) {
      const ts = now + k * stepMin * MIN;
      const R = r ? radarAt(r, ts, thr) : null;
      const M = modelAt(m, ts, thrRate);
      if (!R && !M) { series.push({ ts, p: null, rate: 0, dbz: null, kind: 0, known: false, src: null, w: 0 }); continue; }
      const w = !M ? 1 : R ? radarWeight(R.lead, conf, r.calib && r.calib.weights) : 0;
      if (R && k > 0) radarSteps++;
      const p = w * (R ? R.p : 0) + (1 - w) * (M ? M.p : 0);
      const rate = w * (R ? R.rate : 0) + (1 - w) * (M ? M.rate : 0);
      const kind = R && w >= 0.5 ? R.kind : M ? M.kind : R.kind;
      series.push({
        ts, p, rate, kind, known: true, w,
        dbz: rate > 0.05 ? P.rateToDbz(rate, kind) : null,
        src: w >= 0.99 ? 'radar' : w <= 0.01 ? 'model' : 'mix'
      });
    }

    const at = r && r.atLocation;
    const wetNow = at ? at.dbz !== null && at.dbz !== undefined && at.dbz >= thr : !!(series[0].known && series[0].p >= pThr);
    let eta = null, end = null;
    const lag = r ? Math.max(0, (now - r.frameTime * 1000) / MIN) : 0;
    const legacy = r && !radarSteps && r.nowcast && (r.nowcast.etaMin > 0 || r.nowcast.endMin !== null && r.nowcast.endMin !== undefined);
    if (legacy) {
      // Sin serie utilizable: hora de llegada/fin del radar tal cual (descontando su antigüedad).
      const nc = r.nowcast;
      if (!wetNow && nc.etaMin > 0) eta = { min: Math.max(2, Math.round(nc.etaMin - lag)), early: null, late: null, p: null };
      if (wetNow && nc.endMin !== null && nc.endMin !== undefined) end = { min: Math.max(5, Math.round(nc.endMin - lag)) };
    } else if (!wetNow) {
      const k = wetIndex(series, 1, pThr);
      if (k > 0) {
        const kE = wetIndex(series, 1, Math.max(0.2, pThr - 0.3));
        const kL = wetIndex(series, k, Math.min(0.9, pThr + 0.3));
        let pPeak = 0;
        for (let j = k; j < series.length && j <= k + 6 && series[j].known; j++) pPeak = Math.max(pPeak, series[j].p);
        eta = { min: Math.max(2, k * stepMin), early: kE > 0 ? kE * stepMin : null, late: kL > 0 ? kL * stepMin : null, p: pPeak, src: series[k].src, w: series[k].w };
      }
    } else {
      const k = stopIndex(series, 1, pThr);
      if (k > 0) end = { min: Math.max(5, k * stepMin) };
    }
    let pMax = 0;
    for (const s of series) if (s.known && s.ts - now <= 120 * MIN) pMax = Math.max(pMax, s.p);

    return { now, stepMin, pThr, series, wetNow, eta, end, pMax, legacy: !!legacy, dry: legacy ? null : dryWindow(series, wetNow, pThr) };
  }

  /** ¿La hora de llegada la sostiene el radar (y no solo el modelo)? */
  function radarEta(ol) {
    const e = ol && ol.eta;
    return e && (e.w === undefined || e.w >= 0.5) ? e : null;
  }

  /** Probabilidad del modelo en un instante (para la autoevaluación). */
  function modelProb(model, ts, thrRate) {
    const M = modelAt(model && model.ok ? model : null, ts, thrRate);
    return M ? M.p : null;
  }

  return { blend, dryWindow, radarWeight, radarEta, modelProb, MODEL_INSTANT, RADAR_FULL_MIN };
});
