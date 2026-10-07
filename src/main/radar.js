'use strict';
/*
 * Acceso a RainViewer (API gratuita para uso personal):
 *  - lista de fotogramas: https://api.rainviewer.com/public/weather-maps.json
 *  - tiles: {host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
 * Límites actuales: zoom máx. 7, solo paleta 2, 100 peticiones/min por IP,
 * solo pasado (2 h, cada 10 min). Por eso la previsión la calculamos aquí.
 */
const A = require('./analysis');
const PNG = require('../shared/png');
const P = require('../shared/palette');

const MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const COLOR = 2;

const meanOf = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this.stamps = [];
    this.chain = Promise.resolve();
  }
  run(fn) {
    const job = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter((t) => now - t < 60000);
        if (this.stamps.length < this.perMinute) break;
        await new Promise((r) => setTimeout(r, 60000 - (now - this.stamps[0]) + 50));
      }
      this.stamps.push(Date.now());
    });
    this.chain = job.catch(() => {});
    return job.then(fn);
  }
}

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
}

class RadarSource {
  constructor({ fetch, userAgent, log = () => {}, clutter = null }) {
    this.fetch = fetch;
    this.userAgent = userAgent;
    this.log = log;
    this.clutter = clutter; // ClutterStore (opcional)
    this.maps = null;
    this.mapsAt = 0;
    // El mapa de la ventana también consume del mismo cupo de 100/min,
    // así que el monitor se queda con una parte pequeña.
    this.limiter = new RateLimiter(30);
    // Pocas entradas: solo se usan los 4 últimos fotogramas (≈1 MB por tile).
    this.tiles = new LRU(24);
    this.grids = new LRU(24);
    this.inflight = new Map();
  }

  async getMaps(force = false) {
    if (!force && this.maps && Date.now() - this.mapsAt < 60000) return this.maps;
    const res = await this.limiter.run(() => this.fetch(MAPS_URL, { headers: { 'User-Agent': this.userAgent } }));
    if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
    const json = await res.json();
    const past = (json.radar && json.radar.past) || [];
    if (!json.host || !past.length) throw new Error('RainViewer: respuesta sin fotogramas');
    this.maps = {
      host: json.host,
      generated: json.generated,
      frames: past.map((f) => ({ time: f.time, path: f.path })).sort((a, b) => a.time - b.time)
    };
    this.mapsAt = Date.now();
    return this.maps;
  }

  tileUrl(frame, tx, ty, { size = A.TILE_SIZE, z = A.ZOOM, smooth = 0, snow = 1 } = {}) {
    return `${this.maps.host}${frame.path}/${size}/${z}/${tx}/${ty}/${COLOR}/${smooth}_${snow}.png`;
  }

  async getTile(url) {
    const cached = this.tiles.get(url);
    if (cached !== undefined) return cached;
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = this.limiter.run(async () => {
      const res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent } });
      if (res.status === 429) throw new Error('RainViewer: demasiadas peticiones (429)');
      if (!res.ok) throw new Error(`RainViewer tile HTTP ${res.status}`);
      return PNG.decode(await res.arrayBuffer());
    }).then((img) => { this.tiles.set(url, img); return img; })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  async gridFor(frame, box) {
    const key = `${frame.time}|${box.key}`;
    const hit = this.grids.get(key);
    if (hit) return hit;
    const images = new Map();
    let errors = 0;
    await Promise.all(box.tiles.map(async (t) => {
      try {
        images.set(`${t.tx}/${t.ty}`, await this.getTile(this.tileUrl(frame, t.tx, t.ty)));
      } catch (e) {
        errors++;
        this.log('tile', e.message);
      }
    }));
    if (errors === box.tiles.length) throw new Error('No se pudo descargar el radar');
    const grid = A.buildGrid(box, (t) => images.get(`${t.tx}/${t.ty}`) || null);
    grid.time = frame.time;
    if (!errors) this.grids.set(key, grid);
    return grid;
  }

  /**
   * Analiza una ubicación: estado actual, tendencia, movimiento y nowcast.
   */
  async analyze(loc, { thresholdDbz, alarmRadiusKm, points = null }) {
    const maps = await this.getMaps();
    const frames = maps.frames;
    // Radio de análisis: algo mayor que el de alarma para ver lo que viene.
    const analysisKm = Math.min(170, Math.max(90, alarmRadiusKm * 1.8));
    const box = A.boxFor(loc.lat, loc.lon, analysisKm);

    const use = frames.slice(-4);
    const grids = [];
    for (const f of use) {
      try { grids.push(await this.gridFor(f, box)); } catch (e) { grids.push(null); this.log('grid', e.message); }
    }
    // Si el último fotograma falla, se usa el más reciente que sí se descargó.
    while (grids.length && !grids[grids.length - 1]) grids.pop();
    if (!grids[grids.length - 1]) throw new Error('No se pudo descargar el radar');

    // 1. Ecos fijos a largo plazo y motas sueltas fuera.
    let clutterMask = null;
    if (this.clutter) {
      const cm = this.clutter.forBox(box);
      let changed = false;
      for (const g of grids) if (g && cm.update(g)) changed = true;
      if (changed) this.clutter.saveSoon();
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
}

module.exports = { RadarSource, RateLimiter, MAPS_URL };
