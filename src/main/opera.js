// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
/*
 * Radar europeo EUMETNET OPERA: compuesto de reflectividad máxima de unos
 * 150 radares, con licencia CC BY 4.0. Cada 5 min se publica un GeoTIFF de
 * 3800 × 4400 km (1 km por píxel, proyección LAEA) en el almacén abierto de
 * EUMETNET, unos 4 min después de su hora nominal. Se lee por trozos con
 * peticiones HTTP Range: la cabecera y solo los mosaicos de 512 px que hacen
 * falta, del nivel de detalle adecuado.
 *
 * En memoria, un byte por píxel: 0 sin eco, 255 sin datos (fuera de
 * cobertura) y 1–254 = dBZ en pasos de 0,5 (dbz = q / 2 − 32).
 *
 * OPERA cierra cada compuesto con los radares que le hayan llegado a tiempo,
 * y a menudo falta alguno (en España, a veces medio país durante varios
 * fotogramas seguidos). Esos huecos se tapan con el fotograma anterior más
 * reciente que tenga datos ahí (hasta FILL_MAX), solo donde suele haber radar
 * (usual(): la cobertura de varios fotogramas de las últimas 24 h).
 */
const A = require('./analysis');
const TIFF = require('./tiff');
const { analyzeWith, LRU } = require('./radar');

const BASE_URL = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
const STEP = 300;          // un fotograma cada 5 min
const DELAY = 240;         // tarda ~4 min en publicarse
const RETRY_MISSING = 45;  // s antes de volver a buscar un fotograma que aún no estaba
const FILL_MAX = 1800;     // s: lo más antiguo que puede ser un fotograma para tapar un hueco de otro
// Horas atrás de los fotogramas con que se calcula la cobertura habitual, y cada cuánto se recalcula.
const USUAL_HOURS = [1, 4, 8, 12, 16, 20];
const USUAL_TTL = 6 * 3600 * 1000;
const HEADER_BYTES = 16384;
const NONE = 0, NODATA = 255;
const MIN_DBZ = -10;       // por debajo, ruido de aire claro
const DEG = Math.PI / 180;

const encode = (v, nodata) => {
  if (Number.isNaN(v)) return NONE;
  if (v === nodata || v < -1e5) return NODATA;
  return Math.max(1, Math.min(254, Math.round((v + 32) * 2)));
};
const dbzOf = (q) => q / 2 - 32;

/**
 * Proyección acimutal equivalente de Lambert sobre el elipsoide (Snyder,
 * «Map Projections — A Working Manual», 1987, pp. 187-190).
 */
function laea({ lat0, lon0, falseEasting = 0, falseNorthing = 0, a = 6378137, invFlattening = 298.257223563 }) {
  const f = 1 / invFlattening, e2 = 2 * f - f * f, e = Math.sqrt(e2);
  const q = (s) => (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  const qp = q(1);
  const s0 = Math.sin(lat0 * DEG);
  const b1 = Math.asin(q(s0) / qp);
  const sinB1 = Math.sin(b1), cosB1 = Math.cos(b1);
  const rq = a * Math.sqrt(qp / 2);
  const d = (a * Math.cos(lat0 * DEG)) / Math.sqrt(1 - e2 * s0 * s0) / (rq * cosB1);
  const lam0 = lon0 * DEG;
  const e4 = e2 * e2, e6 = e4 * e2;
  const c2 = e2 / 3 + (31 * e4) / 180 + (517 * e6) / 5040;
  const c4 = (23 * e4) / 360 + (251 * e6) / 3780;
  const c6 = (761 * e6) / 45360;
  return {
    forward(lat, lon) {
      const beta = Math.asin(Math.max(-1, Math.min(1, q(Math.sin(lat * DEG)) / qp)));
      const sb = Math.sin(beta), cb = Math.cos(beta);
      const dl = ((((lon * DEG - lam0) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const den = 1 + sinB1 * sb + cosB1 * cb * Math.cos(dl);
      if (den < 1e-9) return null; // antípoda
      const B = rq * Math.sqrt(2 / den);
      return { e: falseEasting + B * d * cb * Math.sin(dl), n: falseNorthing + (B / d) * (cosB1 * sb - sinB1 * cb * Math.cos(dl)) };
    },
    inverse(E, N) {
      const x = E - falseEasting, y = N - falseNorthing;
      const rho = Math.hypot(x / d, d * y);
      if (rho < 1e-9) return { lat: lat0, lon: lon0 };
      const ce = 2 * Math.asin(Math.min(1, rho / (2 * rq)));
      const sc = Math.sin(ce), cc = Math.cos(ce);
      const beta = Math.asin(cc * sinB1 + (d * y * sc * cosB1) / rho);
      const lam = lam0 + Math.atan2(x * sc, d * rho * cosB1 * cc - d * d * y * sinB1 * sc);
      const lat = beta + c2 * Math.sin(2 * beta) + c4 * Math.sin(4 * beta) + c6 * Math.sin(6 * beta);
      return { lat: lat / DEG, lon: ((((lam / DEG) % 360) + 540) % 360) - 180 };
    }
  };
}

function fileUrl(base, time) {
  const d = new Date(time * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const Y = d.getUTCFullYear(), M = p(d.getUTCMonth() + 1), D = p(d.getUTCDate());
  return `${base}/${Y}/${M}/${D}/OPERA/COMP/OPERA@${Y}${M}${D}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}@0@DBZH.tiff`;
}

/** Fotogramas del mapa: cada 10 min durante 2 h y, si lo hay, el último de 5 min. */
function frameTimes(latest) {
  const lastTen = Math.floor(latest / 600) * 600;
  const out = [];
  for (let k = 12; k >= 0; k--) out.push(lastTen - k * 600);
  if (latest !== lastTen) out.push(latest);
  return out;
}

class OperaSource {
  constructor({ fetch, baseUrl = BASE_URL, userAgent = '', log = () => {}, clutter = null }) {
    this.id = 'opera';
    this.fetch = fetch;
    this.base = baseUrl.replace(/\/+$/, '');
    this.userAgent = userAgent;
    this.log = log;
    this.clutter = clutter;
    this.maps = null;
    this.mapsAt = 0;
    this.latest = null;        // s
    this.missing = new Map();  // time → ms de la última vez que no estaba
    this.headers = new LRU(40);
    this.tiles = new LRU(160); // ≈256 KB cada uno
    this.grids = new LRU(24);
    this.boxMaps = new LRU(12);
    this.views = new LRU(64);  // códigos de teselas del mapa, sin rellenar
    this.inflight = new Map();
    this.usualMask = null;     // promesa de la cobertura habitual
    this.usualAt = 0;
  }

  url(time) { return fileUrl(this.base, time); }

  async range(time, start, end, retry = true) {
    const headers = { Range: `bytes=${start}-${end}` };
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    let res, buf;
    try {
      res = await this.fetch(this.url(time), { headers });
      if (res.status === 404 || res.status === 403) {
        const e = new Error('OPERA: fotograma no disponible');
        e.missing = true;
        throw e;
      }
      if (!res.ok) throw new Error(`OPERA HTTP ${res.status}`);
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      // Un corte de red o un fallo pasajero del servidor: una vez más, al poco.
      if (e.missing || !retry) throw e;
      await new Promise((r) => setTimeout(r, 1000));
      return this.range(time, start, end, false);
    }
    // Un servidor que no admite Range devuelve el fichero entero.
    return res.status === 206 ? buf : buf.subarray(start, end + 1);
  }

  header(time) {
    const key = String(time);
    let p = this.headers.get(key);
    if (!p) {
      p = (async () => {
        for (let n = HEADER_BYTES; ;) {
          const bytes = await this.range(time, 0, n - 1);
          try {
            return this.prepare(TIFF.parseHeader(bytes));
          } catch (e) {
            if (!(e instanceof TIFF.NeedMore) || bytes.length < n || n >= 1 << 20) throw e;
            n = Math.ceil(e.bytes / HEADER_BYTES) * HEADER_BYTES;
          }
        }
      })();
      p.catch(() => this.headers.delete(key));
      this.headers.set(key, p);
    }
    return p;
  }

  prepare(h) {
    if (!h.geo || !h.geo.laea) throw new Error('OPERA: proyección no reconocida');
    const top = h.ifds[0];
    const levels = h.ifds.filter((f) => f.bits === 32 && f.sampleFormat === 3).map((f) => ({
      ...f,
      fx: f.width / top.width, fy: f.height / top.height,
      sizeM: (h.geo.pixelX * top.width) / f.width
    }));
    const g = h.geo, l = g.laea;
    return {
      levels, geo: g, proj: laea(l),
      geomKey: [top.width, top.height, g.originX, g.originY, g.pixelX, l.lat0, l.lon0, l.falseEasting, l.falseNorthing].join(',')
    };
  }

  /** Posición continua en el nivel 0 (el píxel es la parte entera) o null. */
  toPixel(h, lat, lon) {
    const p = h.proj.forward(lat, lon);
    return p && { u: (p.e - h.geo.originX) / h.geo.pixelX, v: (h.geo.originY - p.n) / h.geo.pixelY };
  }

  tile(time, h, level, k) {
    const key = `${time}/${level}/${k}`;
    const hit = this.tiles.get(key);
    if (hit) return Promise.resolve(hit);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const ifd = h.levels[level];
    const p = (async () => {
      const off = ifd.tileOffsets[k], len = ifd.tileByteCounts[k];
      const n = ifd.tileWidth * ifd.tileHeight;
      if (!len) return new Uint8Array(n).fill(NODATA); // mosaico vacío
      const f = await TIFF.decodeTile(ifd, await this.range(time, off, off + len - 1));
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = encode(f[i], ifd.nodata);
      return out;
    })().then((t) => { this.tiles.set(key, t); return t; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Descarga los mosaicos de un nivel que cubren [c0, c1] × [r0, r1]. */
  async tilesFor(time, h, level, c0, r0, c1, r1) {
    const ifd = h.levels[level];
    const tiles = new Map();
    const tx0 = Math.max(0, Math.floor(c0 / ifd.tileWidth)), tx1 = Math.min(ifd.tilesAcross - 1, Math.floor(c1 / ifd.tileWidth));
    const ty0 = Math.max(0, Math.floor(r0 / ifd.tileHeight)), ty1 = Math.min(ifd.tilesDown - 1, Math.floor(r1 / ifd.tileHeight));
    const jobs = [];
    let errors = 0, last = null;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = ty * ifd.tilesAcross + tx;
        jobs.push(this.tile(time, h, level, k).then((t) => tiles.set(k, t), (e) => { errors++; last = e; this.log('opera', e.message); }));
      }
    }
    await Promise.all(jobs);
    if (jobs.length && errors === jobs.length) throw last;
    const { width: W, height: H, tileWidth: tw, tileHeight: th, tilesAcross } = ifd;
    // Código del píxel (c, r) del nivel; NODATA fuera de la imagen o si falló el mosaico.
    const get = (c, r) => {
      if (c < 0 || r < 0 || c >= W || r >= H) return NODATA;
      const t = tiles.get(((r / th) | 0) * tilesAcross + ((c / tw) | 0));
      return t ? t[(r % th) * tw + (c % tw)] : NODATA;
    };
    get.failed = errors; // mosaicos que no se pudieron descargar
    return get;
  }

  // ------------------------------------------------------------------
  // Cobertura habitual

  /**
   * Píxeles del nivel más grueso (unos 16 km) que tuvieron datos en alguno de
   * los fotogramas de USUAL_HOURS: dónde suele haber radar. Distingue «aquí no
   * llega el radar» de «a este fotograma le falta algún radar». Se recalcula
   * cada USUAL_TTL; si no se consigue, la promesa falla (y se reintenta).
   */
  usual() {
    if (this.usualMask && Date.now() - this.usualAt < USUAL_TTL) return this.usualMask;
    const ref = this.latest || Math.floor((Date.now() / 1000 - DELAY) / STEP) * STEP;
    const p = (async () => {
      const got = await Promise.allSettled(USUAL_HOURS.map(async (hours) => {
        const time = ref - hours * 3600;
        const h = await this.header(time);
        const level = h.levels.length - 1;
        const ifd = h.levels[level];
        const get = await this.tilesFor(time, h, level, 0, 0, ifd.width - 1, ifd.height - 1);
        if (get.failed) throw new Error('OPERA: faltan mosaicos');
        return { h, ifd, get };
      }));
      let out = null;
      for (const r of got) {
        if (r.status !== 'fulfilled') continue;
        const { h, ifd, get } = r.value;
        if (!out) out = { geomKey: h.geomKey, w: ifd.width, h: ifd.height, fx: ifd.fx, fy: ifd.fy, mask: new Uint8Array(ifd.width * ifd.height) };
        if (h.geomKey !== out.geomKey || ifd.width !== out.w || ifd.height !== out.h) continue;
        for (let r0 = 0; r0 < out.h; r0++) for (let c = 0; c < out.w; c++) if (get(c, r0) !== NODATA) out.mask[r0 * out.w + c] = 1;
      }
      if (!out) throw new Error('OPERA: no se pudo calcular la cobertura habitual');
      return out;
    })();
    this.usualMask = p;
    this.usualAt = Date.now();
    p.catch(() => { if (this.usualMask === p) this.usualMask = null; });
    return p;
  }

  /** ¿Suele haber radar en (u, v), posición continua en el nivel 0? */
  static isUsual(cov, u, v) {
    const c = Math.floor(u * cov.fx), r = Math.floor(v * cov.fy);
    return c >= 0 && r >= 0 && c < cov.w && r < cov.h && cov.mask[r * cov.w + c] === 1;
  }

  /** ¿Suele haber radar en este punto? true/false, o null si no se sabe. */
  async usuallyCovered(lat, lon) {
    if (!this.latest) return null;
    try {
      const cov = await this.usual();
      const h = await this.header(this.latest);
      if (h.geomKey !== cov.geomKey) return null;
      const p = this.toPixel(h, lat, lon);
      return !!p && OperaSource.isUsual(cov, p.u, p.v);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Fotogramas

  async getMaps(force = false) {
    if (!force && this.maps && Date.now() - this.mapsAt < 60000) return this.maps;
    const now = Date.now() / 1000;
    const newest = Math.floor((now - DELAY) / STEP) * STEP;
    // Solo se pregunta por fotogramas que ya deberían estar; los que faltaban
    // se vuelven a buscar pasado un rato.
    if (!this.latest || newest > this.latest) {
      let lastError = null;
      for (let t = newest; t > newest - 6 * STEP && t > (this.latest || 0); t -= STEP) {
        const miss = this.missing.get(t);
        if (miss && Date.now() - miss < RETRY_MISSING * 1000) continue;
        try {
          await this.header(t);
          this.latest = t;
          this.missing.delete(t);
          break;
        } catch (e) {
          if (!e.missing) { lastError = e; break; }
          this.missing.set(t, Date.now());
        }
      }
      for (const t of this.missing.keys()) if (t < now - 3600) this.missing.delete(t);
      if (!this.latest) throw lastError || new Error('OPERA: no hay fotogramas recientes');
      this.usual().catch(() => {}); // para cuando haga falta (mapa y análisis)
    }
    if (!this.maps || this.maps.generated !== this.latest) {
      this.maps = {
        source: 'opera',
        generated: this.latest,
        frames: frameTimes(this.latest).map((time) => ({ time, path: `opera/${time}` }))
      };
    }
    this.mapsAt = Date.now();
    return this.maps;
  }

  // ------------------------------------------------------------------
  // Análisis: la rejilla de la caja (Web Mercator, ver analysis.js)

  boxMap(h, box) {
    const key = `${h.geomKey}|${box.key}`;
    let m = this.boxMaps.get(key);
    if (m) return m;
    const n = box.w * box.h;
    const col = new Int32Array(n).fill(-1), row = new Int32Array(n).fill(-1);
    let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
    const top = h.levels[0];
    for (let gy = 0; gy < box.h; gy++) {
      for (let gx = 0; gx < box.w; gx++) {
        const ll = A.unproject(box.x0 + gx + 0.5, box.y0 + gy + 0.5);
        const p = this.toPixel(h, ll.lat, ll.lon);
        if (!p) continue;
        const c = Math.floor(p.u), r = Math.floor(p.v);
        if (c < 0 || r < 0 || c >= top.width || r >= top.height) continue;
        const i = gy * box.w + gx;
        col[i] = c; row[i] = r;
        if (c < c0) c0 = c; if (c > c1) c1 = c;
        if (r < r0) r0 = r; if (r > r1) r1 = r;
      }
    }
    m = { col, row, bounds: c0 <= c1 ? [c0, r0, c1, r1] : null };
    this.boxMaps.set(key, m);
    return m;
  }

  async gridFor(frame, box) {
    const key = `${frame.time}|${box.key}`;
    const hit = this.grids.get(key);
    if (hit) return hit;
    const h = await this.header(frame.time);
    const m = this.boxMap(h, box);
    const n = box.w * box.h;
    const dbz = new Float32Array(n).fill(NaN);
    const kind = new Uint8Array(n).fill(NODATA); // 0 nada, 1 lluvia, 255 sin datos
    let missing = n;
    if (m.bounds) {
      const get = await this.tilesFor(frame.time, h, 0, ...m.bounds);
      // Con un mosaico de menos, media zona saldría «sin datos»: mejor otro fotograma.
      if (get.failed) throw new Error('OPERA: faltan mosaicos');
      for (let i = 0; i < n; i++) {
        if (m.col[i] < 0) continue;
        const q = get(m.col[i], m.row[i]);
        if (q === NODATA) continue;
        missing--;
        kind[i] = 0;
        if (q === NONE) continue;
        const d = dbzOf(q);
        if (d >= MIN_DBZ) { dbz[i] = d; kind[i] = 1; } // OPERA no distingue la nieve
      }
    }
    const grid = { w: box.w, h: box.h, dbz, kind, missingFraction: missing / n, time: frame.time };
    this.grids.set(key, grid);
    return grid;
  }

  clutterBox(box) { return { ...box, key: `opera-${box.key}` }; }

  analyze(loc, opts) { return analyzeWith(this, loc, { ...opts, requireCoverage: true, fillMaxS: FILL_MAX }); }

  // ------------------------------------------------------------------
  // Mapa: un tesela de Web Mercator (z/x/y) con un byte por píxel

  async viewTile({ time, z, x, y, size = 256, smooth = false } = {}) {
    time = Number(time); z = Math.round(Number(z)); x = Math.round(Number(x)); y = Math.round(Number(y));
    size = size === 512 ? 512 : 256;
    smooth = !!smooth;
    if (!Number.isFinite(time) || !(z >= 0 && z <= 14) || !Number.isFinite(x) || !(y >= 0 && y < 2 ** z)) throw new Error('Tesela no válida');
    const n = 2 ** z;
    x = ((x % n) + n) % n;
    // La cobertura habitual suele estar ya (se pide con los fotogramas); si tarda, la tesela no la espera.
    let timer;
    const cov = await Promise.race([this.usual().catch(() => null), new Promise((r) => { timer = setTimeout(r, 2000, null); })]);
    clearTimeout(timer);
    const own = await this.viewCodes(time, z, x, y, size, smooth);
    // Copia: la de la caché no se toca (la web la pasa a la página sin copiarla).
    const out = own.codes.slice();
    if (!cov || own.geomKey !== cov.geomKey) return out;

    // Huecos: sin datos donde suele haber radar. Se tapan con los fotogramas
    // anteriores de la animación (los mismos mosaicos, casi siempre ya en la caché).
    if (!own.pos) return out;
    const { U, V, cells, G, fx: lx, fy: ly } = own.pos;
    let gaps = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== NODATA) continue;
      const px = i % size, py = (i - px) / size;
      const gj = (py + 0.5) / G, j0 = Math.min(cells - 2, Math.floor(gj)), fy = gj - j0;
      const gi = (px + 0.5) / G, i0 = Math.min(cells - 2, Math.floor(gi)), fx = gi - i0;
      const k = j0 * cells + i0;
      const u = (U[k] * (1 - fx) + U[k + 1] * fx) * (1 - fy) + (U[k + cells] * (1 - fx) + U[k + cells + 1] * fx) * fy;
      const v = (V[k] * (1 - fx) + V[k + 1] * fx) * (1 - fy) + (V[k + cells] * (1 - fx) + V[k + cells + 1] * fx) * fy;
      if (Number.isFinite(u) && Number.isFinite(v) && OperaSource.isUsual(cov, u / lx, v / ly)) gaps.push(i);
    }
    if (!gaps.length) return out;
    const listed = this.maps ? this.maps.frames.map((f) => f.time) : [time - 600, time - 1200, time - 1800];
    const before = listed.filter((t) => t < time && time - t <= FILL_MAX).sort((a, b) => b - a);
    for (const t of before) {
      let prev;
      try { prev = await this.viewCodes(t, z, x, y, size, smooth); } catch (e) { continue; }
      gaps = gaps.filter((i) => {
        const q = prev.codes[i];
        if (q === NODATA) return true;
        out[i] = q;
        return false;
      });
      if (!gaps.length) break;
    }
    return out;
  }

  /**
   * Códigos de una tesela de un fotograma, sin rellenar, y la posición en el
   * nivel usado cada G píxeles (pos; null si la tesela cae fuera). Se guardan
   * en una caché (son también los de la animación). Falla si falta algún mosaico.
   */
  viewCodes(time, z, x, y, size, smooth) {
    const key = `${time}/${z}/${x}/${y}/${size}/${smooth ? 1 : 0}`;
    let p = this.views.get(key);
    if (!p) {
      p = this.computeView(time, z, x, y, size, smooth);
      p.catch(() => this.views.delete(key));
      this.views.set(key, p);
    }
    return p;
  }

  async computeView(time, z, x, y, size, smooth) {
    const n = 2 ** z;
    const codes = new Uint8Array(size * size).fill(NODATA);
    const h = await this.header(time);

    // Nivel de detalle: el más grueso que no se vea borroso a este zoom.
    const mpp = (40075016.686 * Math.cos(50 * DEG)) / (size * n);
    let level = 0;
    for (let i = h.levels.length - 1; i > 0; i--) if (h.levels[i].sizeM <= mpp * 1.6) { level = i; break; }
    const ifd = h.levels[level];

    // Posición en el nivel cada G píxeles; en medio se interpola (la proyección es suave).
    const G = 8, cells = size / G + 1, world = size * n;
    const U = new Float64Array(cells * cells), V = new Float64Array(cells * cells);
    let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
    for (let j = 0; j < cells; j++) {
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * size + j * G)) / world))) / DEG;
      for (let i = 0; i < cells; i++) {
        const lon = ((x * size + i * G) / world) * 360 - 180;
        const p = this.toPixel(h, lat, lon);
        const k = j * cells + i;
        // Lejos de Europa la proyección se deforma: ahí no hay datos.
        if (!p || Math.abs(p.u) > 3 * ifd.width / ifd.fx || Math.abs(p.v) > 3 * ifd.height / ifd.fy) { U[k] = NaN; V[k] = NaN; continue; }
        U[k] = p.u * ifd.fx; V[k] = p.v * ifd.fy;
        if (U[k] < c0) c0 = U[k]; if (U[k] > c1) c1 = U[k];
        if (V[k] < r0) r0 = V[k]; if (V[k] > r1) r1 = V[k];
      }
    }
    if (!(c1 >= -1 && r1 >= -1 && c0 <= ifd.width && r0 <= ifd.height)) return { codes, pos: null, geomKey: h.geomKey };
    const get = await this.tilesFor(time, h, level, Math.floor(c0) - 1, Math.floor(r0) - 1, Math.ceil(c1) + 1, Math.ceil(r1) + 1);
    // Un mosaico de menos dejaría un trozo vacío que nadie volvería a pedir: mejor fallar y que se reintente.
    if (get.failed) throw new Error('OPERA: faltan mosaicos');

    for (let py = 0; py < size; py++) {
      const gj = (py + 0.5) / G, j0 = Math.min(cells - 2, Math.floor(gj)), fy = gj - j0;
      for (let px = 0; px < size; px++) {
        const gi = (px + 0.5) / G, i0 = Math.min(cells - 2, Math.floor(gi)), fx = gi - i0;
        const k = j0 * cells + i0;
        const u = (U[k] * (1 - fx) + U[k + 1] * fx) * (1 - fy) + (U[k + cells] * (1 - fx) + U[k + cells + 1] * fx) * fy;
        const v = (V[k] * (1 - fx) + V[k + 1] * fx) * (1 - fy) + (V[k + cells] * (1 - fx) + V[k + cells + 1] * fx) * fy;
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        let q = get(Math.floor(u), Math.floor(v));
        if (smooth && q !== NODATA) {
          // Suavizado bilineal en dBZ ("sin eco" cuenta como −32 dBZ, el código 0).
          const su = u - 0.5, sv = v - 0.5, cu = Math.floor(su), rv = Math.floor(sv), au = su - cu, av = sv - rv;
          const q00 = get(cu, rv), q10 = get(cu + 1, rv), q01 = get(cu, rv + 1), q11 = get(cu + 1, rv + 1);
          if (q00 !== NODATA && q10 !== NODATA && q01 !== NODATA && q11 !== NODATA) {
            q = Math.round((q00 * (1 - au) + q10 * au) * (1 - av) + (q01 * (1 - au) + q11 * au) * av);
          }
        }
        codes[py * size + px] = q;
      }
    }
    return { codes, pos: { U, V, cells, G, fx: ifd.fx, fy: ifd.fy }, geomKey: h.geomKey };
  }
}

module.exports = { OperaSource, laea, fileUrl, frameTimes, encode, dbzOf, BASE_URL, NONE, NODATA, STEP, DELAY, FILL_MAX };
