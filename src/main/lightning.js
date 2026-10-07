'use strict';
/*
 * Rayos observados desde el satélite Meteosat-12 (MTG Lightning Imager) a
 * través del servicio de mapas EUMETView de EUMETSAT: capa li_afa, "área de
 * destellos acumulada" cada 5 min. Datos "Core" de EUMETSAT, gratis y bajo
 * licencia CC BY 4.0 (hay que citar la fuente). Sin clave.
 *
 * Cubre Europa, África, Oriente Medio y parte de Sudamérica. Llega con unos
 * 15 min de retraso: sirve para saber que hay tormenta eléctrica cerca, no
 * para seguir cada rayo.
 *
 * (Blitzortung no se usa: sus condiciones prohíben expresamente usar sus
 * datos en sistemas de aviso de tormentas.)
 */
const PNG = require('../shared/png');

const WMS = 'https://view.eumetsat.int/geoserver/mtg_fd/li_afa/wms';
const CAPS_TTL = 4 * 60000;
const STEP_MIN = 5;
const STEPS = 3;            // últimos 15 min
const KM_PER_DEG = 111.32;

const DEG = Math.PI / 180;

function inCoverage(lat, lon) {
  return Math.abs(lat) <= 70 && Math.abs(lon) <= 70;
}

function bearingDeg(dxKm, dyKmSouth) {
  return (Math.atan2(dxKm, -dyKmSouth) / DEG + 360) % 360;
}

class LightningSource {
  constructor({ fetch, userAgent, log = () => {} }) {
    this.fetch = fetch;
    this.userAgent = userAgent;
    this.log = log;
    this.latest = null;  // ms
    this.latestAt = 0;
    this.images = new Map(); // url -> Promise<{width,height,data}>
  }

  async latestTime() {
    if (this.latest && Date.now() - this.latestAt < CAPS_TTL) return this.latest;
    const res = await this.fetch(`${WMS}?service=WMS&version=1.3.0&request=GetCapabilities`, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error(`EUMETSAT HTTP ${res.status}`);
    const xml = await res.text();
    const m = xml.match(/<Dimension[^>]*name="time"[^>]*default="([^"]+)"/);
    if (!m) throw new Error('EUMETSAT: sin dimensión de tiempo');
    const ts = Date.parse(m[1]);
    if (!isFinite(ts)) throw new Error('EUMETSAT: hora no válida');
    this.latest = ts;
    this.latestAt = Date.now();
    return ts;
  }

  image(url) {
    if (!this.images.has(url)) {
      const p = this.fetch(url, { headers: { 'User-Agent': this.userAgent } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`EUMETSAT HTTP ${res.status}`);
          return PNG.decode(await res.arrayBuffer());
        });
      p.catch(() => this.images.delete(url));
      this.images.set(url, p);
      while (this.images.size > 40) this.images.delete(this.images.keys().next().value);
    }
    return this.images.get(url);
  }

  /**
   * Destellos en los últimos 15 min alrededor de un punto. Devuelve
   * { ok, time, nearest: {distanceKm, bearingDeg, ageMin} | null, countKm2 }.
   */
  async around(lat, lon, radiusKm = 60) {
    if (!inCoverage(lat, lon)) return { ok: false, coverage: false };
    const latest = await this.latestTime();
    const size = Math.round(radiusKm * 2); // ≈ 1 km por píxel
    const dLat = radiusKm / KM_PER_DEG;
    const dLon = radiusKm / (KM_PER_DEG * Math.cos(lat * DEG));
    // Caja redondeada a 0,01° para reaprovechar imágenes entre comprobaciones.
    const r2 = (v) => Math.round(v * 100) / 100;
    const bbox = [r2(lon - dLon), r2(lat - dLat), r2(lon + dLon), r2(lat + dLat)];
    const kmX = ((bbox[2] - bbox[0]) * KM_PER_DEG * Math.cos(lat * DEG)) / size;
    const kmY = ((bbox[3] - bbox[1]) * KM_PER_DEG) / size;
    const cx = ((lon - bbox[0]) / (bbox[2] - bbox[0])) * size;
    const cy = ((bbox[3] - lat) / (bbox[3] - bbox[1])) * size;

    let nearest = null, area = 0;
    for (let k = 0; k < STEPS; k++) {
      const time = latest - k * STEP_MIN * 60000;
      const url = `${WMS}?service=WMS&version=1.1.1&request=GetMap&layers=li_afa&styles=&srs=EPSG:4326&format=image/png&transparent=true` +
        `&bbox=${bbox.join(',')}&width=${size}&height=${size}&time=${new Date(time).toISOString().replace('.000', '')}`;
      let img;
      try { img = await this.image(url); } catch (e) { if (k === 0) throw e; this.log('lightning', e.message); continue; }
      const ageMin = Math.round((Date.now() - time) / 60000);
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (img.data[(y * img.width + x) * 4 + 3] < 40) continue;
          const dx = (x + 0.5 - cx) * kmX, dy = (y + 0.5 - cy) * kmY;
          const d = Math.hypot(dx, dy);
          if (d > radiusKm) continue;
          if (k === 0) area += kmX * kmY;
          if (!nearest || d < nearest.distanceKm - 0.01 || (Math.abs(d - nearest.distanceKm) < 0.01 && ageMin < nearest.ageMin)) {
            nearest = { distanceKm: d, bearingDeg: bearingDeg(dx, dy), ageMin };
          }
        }
      }
    }
    return { ok: true, time: latest, radiusKm, nearest, areaKm2: Math.round(area) };
  }
}

const R_EARTH = 6378137;

/**
 * Rayos de los últimos 15 min en la vista del mapa (bbox en Web Mercator),
 * agrupados en celdas de `cellPx` píxeles para dibujarlos como iconos.
 * Cada punto: { lat, lon, level 0..2 (densidad de destellos), age 0..2
 * (0 = el paso más reciente) }.
 */
LightningSource.prototype.inView = async function inView(bbox, width, height, { cellPx = 16, max = 300 } = {}) {
  const latest = await this.latestTime();
  this.viewCache = this.viewCache || new Map();
  const cells = new Map();
  for (let k = 0; k < STEPS; k++) {
    const time = latest - k * STEP_MIN * 60000;
    const url = `${WMS}?service=WMS&version=1.1.1&request=GetMap&layers=li_afa&styles=&srs=EPSG:3857&format=image/png&transparent=true` +
      `&bbox=${bbox.map((v) => Math.round(v)).join(',')}&width=${width}&height=${height}&time=${new Date(time).toISOString().replace('.000', '')}`;
    let img = this.viewCache.get(url);
    if (!img) {
      try {
        const res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent } });
        if (!res.ok) throw new Error(`EUMETSAT HTTP ${res.status}`);
        img = await PNG.decode(await res.arrayBuffer());
        this.viewCache.set(url, img);
        while (this.viewCache.size > 6) this.viewCache.delete(this.viewCache.keys().next().value);
      } catch (e) {
        if (k === 0) throw e;
        this.log('lightning', e.message);
        continue;
      }
    }
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        if (img.data[o + 3] < 40) continue;
        const key = `${Math.floor(x / cellPx)},${Math.floor(y / cellPx)}`;
        let c = cells.get(key);
        if (c && c.age < k) continue; // ya hay destellos más recientes en esta celda
        if (!c) { c = { age: k, sx: 0, sy: 0, n: 0, level: 0 }; cells.set(key, c); }
        // La capa va de amarillo claro (pocos destellos) a rojo oscuro (muchos).
        const g = img.data[o + 1];
        const level = g < 110 ? 2 : g < 200 ? 1 : 0;
        c.sx += x; c.sy += y; c.n++;
        if (level > c.level) c.level = level;
      }
    }
  }
  const points = [];
  for (const c of cells.values()) {
    const mx = bbox[0] + ((c.sx / c.n + 0.5) / width) * (bbox[2] - bbox[0]);
    const my = bbox[3] - ((c.sy / c.n + 0.5) / height) * (bbox[3] - bbox[1]);
    points.push({
      lat: (Math.atan(Math.sinh(my / R_EARTH)) * 180) / Math.PI,
      lon: ((mx / R_EARTH) * 180) / Math.PI,
      level: c.level, age: c.age
    });
  }
  points.sort((a, b) => a.age - b.age || b.level - a.level);
  return { time: latest, points: points.slice(0, max) };
};

module.exports = { LightningSource, inCoverage, WMS };
