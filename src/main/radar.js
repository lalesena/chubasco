'use strict';
/*
 * Análisis del radar común a cualquier fuente que ofrezca getMaps()
 * (fotogramas) y gridFor(fotograma, caja) (rejilla de dBZ), hoy OPERA
 * (ver opera.js), y una caché LRU pequeña.
 */
const A = require('./analysis');
const P = require('../shared/palette');

const meanOf = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    this.map.delete(k); this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(k) { this.map.delete(k); }
}

/**
 * Analiza una ubicación con una fuente de radar (getMaps + gridFor): estado
 * actual, tendencia, movimiento y nowcast.
 */
async function analyzeWith(src, loc, { thresholdDbz, alarmRadiusKm, points = null, requireCoverage = false }) {
  const maps = await src.getMaps();
  const frames = maps.frames;
  // Radio de análisis: algo mayor que el de alarma para ver lo que viene.
  const analysisKm = Math.min(170, Math.max(90, alarmRadiusKm * 1.8));
  const box = A.boxFor(loc.lat, loc.lon, analysisKm);

  const use = frames.slice(-4);
  const grids = [];
  for (const f of use) {
    try { grids.push(await src.gridFor(f, box)); } catch (e) { grids.push(null); src.log('grid', e.message); }
  }
  // Si el último fotograma falla, se usa el más reciente que sí se descargó.
  while (grids.length && !grids[grids.length - 1]) grids.pop();
  if (!grids[grids.length - 1]) throw new Error('No se pudo descargar el radar');

  // 1. Ecos fijos a largo plazo y motas sueltas fuera.
  let clutterMask = null;
  if (src.clutter) {
    const cm = src.clutter.forBox(src.clutterBox ? src.clutterBox(box) : box);
    let changed = false;
    for (const g of grids) if (g && cm.update(g)) changed = true;
    if (changed) src.clutter.saveSoon();
    clutterMask = cm.mask();
  }
  const minPx = A.minPixelsFor(box);
  let base = grids.map((g) => g && A.cleanGrid(g, { thresholdDbz: 10, minPx, clutter: clutterMask }));

  // 2. Movimiento global; si la lluvia se mueve, se quitan los ecos que no
  // lo hacen (sesgan el vector hacia "quieto") y se vuelve a estimar.
  const motionOf = (gs) => {
    const pairs = [];
    for (let i = 1; i < gs.length; i++) {
      if (!gs[i - 1] || !gs[i]) continue;
      const dt = (gs[i].time - gs[i - 1].time) / 60;
      pairs.push({ a: gs[i - 1], b: gs[i], dt, m: A.estimateMotion(gs[i - 1], gs[i], box, dt) });
    }
    return { pairs, motion: A.combineMotion(pairs.map((p) => p.m), box) };
  };
  let { pairs, motion } = motionOf(base);
  let staticPx = 0;
  if (motion && motion.speedKmh >= 10) {
    const st = A.staticEchoes(base, box);
    if (st) {
      staticPx = st.reduce((s, v) => s + v, 0);
      ({ pairs, motion } = motionOf(base.map((g) => g && A.cleanGrid(g, { thresholdDbz: 10, minPx, clutter: st }))));
    }
  }
  if (motion && motion.confidence < 0.2) motion = null;

  // 3. Movimiento por zonas y tendencia de intensidad.
  const field = motion ? A.combineFields(pairs.map((p) => A.estimateMotionField(p.a, p.b, box, p.dt, p.m)), motion) : null;
  const usable = base.filter(Boolean);
  const latestBase = usable[usable.length - 1];
  const olderBase = usable.length >= 3 ? usable[usable.length - 3] : null;
  const trend = motion && olderBase
    ? A.intensityTrend(olderBase, latestBase, box, (latestBase.time - olderBase.time) / 60, motion, field)
    : null;

  // 4. Estado y previsión con el umbral de esta alarma.
  const clean = (g) => g && A.cleanGrid(g, { thresholdDbz, minPx });
  const latest = clean(latestBase);
  const stats = A.locationStats(latest, box, { alarmRadiusKm, thresholdDbz, searchRadiusKm: analysisKm });
  // Fuera de la cobertura del radar (OPERA solo cubre Europa).
  if (requireCoverage && !stats.atLocation.hasData && stats.missingFraction > 0.5) {
    const e = new Error('Sin cobertura de radar');
    e.code = 'noCoverage';
    throw e;
  }
  const nc = A.nowcast(latest, box, motion, { thresholdDbz, horizonMin: 120, stepMin: 5, field, trend });
  // Previsión en otros puntos de la misma caja (p. ej. a lo largo de un trayecto).
  const extra = (points || []).map((p) => {
    const c = A.project(p.lat, p.lon);
    const pn = A.nowcast(latest, box, motion, { thresholdDbz, horizonMin: 120, stepMin: 5, field, trend, at: { x: c.x - box.x0, y: c.y - box.y0 } });
    return { lat: p.lat, lon: p.lon, nowcast: { stepMin: pn.stepMin, series: pn.series.map((s) => ({ t: s.t, p: s.p, dbz: s.dbz, kind: s.kind, known: s.known, rate: s.rate })) } };
  });

  // Tendencia: distancia al eco más cercano hace ~20 min.
  let trendKmPer10 = null;
  const older = clean(olderBase || (usable.length > 1 ? usable[0] : null));
  if (older && stats.nearestAny) {
    const s0 = A.locationStats(older, box, { alarmRadiusKm, thresholdDbz, searchRadiusKm: analysisKm });
    if (s0.nearestAny) {
      const dtMin = (latest.time - older.time) / 60;
      trendKmPer10 = ((stats.nearestAny.distanceKm - s0.nearestAny.distanceKm) / dtMin) * 10;
    }
  }

  // ¿Se acerca? Vector de movimiento apuntando hacia nosotros o distancia bajando.
  let approaching = false;
  const ref = stats.nearestAny;
  if (ref) {
    if (nc.etaMin !== null && nc.etaMin > 0) approaching = true;
    else if (motion && motion.speedKmh > 3) {
      const toUs = (ref.bearingDeg + 180) % 360;
      const diff = Math.abs(((motion.headingDeg - toUs + 540) % 360) - 180);
      approaching = diff < 60;
    } else if (trendKmPer10 !== null && trendKmPer10 < -1.5) approaching = true;
  }

  const withRate = (o) => (o && o.dbz !== null ? { ...o, rate: P.dbzToRate(o.dbz, o.kind) } : o);
  return {
    ok: true,
    source: src.id,
    frameTime: latest.time,
    checkedAt: Date.now(),
    analysisKm,
    missingFraction: latest.missingFraction,
    atLocation: withRate(stats.atLocation),
    nearest: withRate(stats.nearest),
    nearestAny: withRate(stats.nearestAny),
    maxInRadius: withRate(stats.maxInRadius),
    strongest: stats.strongest,
    wetFraction: stats.wetFraction,
    motion: motion && {
      vEast: motion.vEast, vNorth: motion.vNorth, speedKmh: motion.speedKmh,
      headingDeg: motion.headingDeg, confidence: motion.confidence,
      zones: field ? Array.from(field.alpha).filter((a) => a > 0.3).length : 0
    },
    nowcast: {
      etaMin: nc.etaMin, etaEarly: nc.etaEarly, etaLate: nc.etaLate, endMin: nc.endMin, stepMin: nc.stepMin,
      members: nc.members,
      series: nc.series.map((s) => ({ t: s.t, p: s.p, dbz: s.dbz, kind: s.kind, known: s.known, rate: s.rate }))
    },
    growthDbzPer10: trend ? meanOf(trend.d) : null,
    filtered: { clutterPx: clutterMask ? clutterMask.reduce((s, v) => s + v, 0) : 0, staticPx, speckles: latest.removed },
    trendKmPer10,
    approaching,
    points: extra
  };
}

module.exports = { LRU, analyzeWith };
