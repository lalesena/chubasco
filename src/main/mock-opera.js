// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
/*
 * GeoTIFF sintético con la misma forma que el compuesto OPERA (rejilla,
 * proyección, niveles y mosaicos de 512 px), para el modo demostración y
 * las pruebas. Sin comprimir y generado por trozos: solo se calculan los
 * mosaicos que se piden.
 */
const { laea } = require('./opera');

const GEO = { lat0: 55, lon0: 10, falseEasting: 1950000, falseNorthing: -2100000, a: 6378137, invFlattening: 298.257223563 };
const LEVELS = [[3800, 4400], [1900, 2200], [950, 1100], [475, 550], [237, 275]];
const TILE = 512;
const TILE_BYTES = TILE * TILE * 4;
const DATA_START = 16384;
const NODATA = -9999000;

// Tipos TIFF: 3 SHORT, 4 LONG, 2 ASCII, 12 DOUBLE
function header() {
  const tileCounts = LEVELS.map(([w, h]) => Math.ceil(w / TILE) * Math.ceil(h / TILE));
  const firstTile = [];
  tileCounts.reduce((acc, n) => { firstTile.push(acc); return acc + n; }, 0);
  const keys = [1, 1, 0, 12,
    1024, 0, 1, 1, 1025, 0, 1, 1, 2057, 34736, 1, 4, 2059, 34736, 1, 5,
    3072, 0, 1, 32767, 3074, 0, 1, 32767, 3075, 0, 1, 10, 3076, 0, 1, 9001,
    3082, 34736, 1, 0, 3083, 34736, 1, 1, 3088, 34736, 1, 2, 3089, 34736, 1, 3];
  const doubles = [GEO.falseEasting, GEO.falseNorthing, GEO.lon0, GEO.lat0, GEO.a, GEO.invFlattening];

  const ifds = LEVELS.map(([w, h], l) => {
    const n = tileCounts[l];
    const offsets = Array.from({ length: n }, (_, k) => DATA_START + (firstTile[l] + k) * TILE_BYTES);
    const e = [];
    if (l) e.push([254, 4, [1]]);
    e.push([256, 4, [w]], [257, 4, [h]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]], [277, 3, [1]], [284, 3, [1]],
      [322, 3, [TILE]], [323, 3, [TILE]], [324, 4, offsets], [325, 4, offsets.map(() => TILE_BYTES)], [339, 3, [3]]);
    if (!l) e.push([33550, 12, [1000, 1000, 0]], [33922, 12, [0, 0, 0, -500, 500, 0]], [34735, 3, keys], [34736, 12, doubles]);
    e.push([42113, 2, '-9999000\0']);
    return e;
  });

  const buf = new ArrayBuffer(DATA_START);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x49; u8[1] = 0x49; dv.setUint16(2, 42, true);
  let pos = 8;
  dv.setUint32(4, pos, true);
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
  ifds.forEach((entries, l) => {
    const start = pos;
    dv.setUint16(start, entries.length, true);
    let extra = start + 2 + entries.length * 12 + 4;
    entries.forEach(([tag, type, vals], i) => {
      const e = start + 2 + i * 12;
      const count = vals.length;
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
      let at = e + 8;
      if (size[type] * count > 4) { extra = (extra + 7) & ~7; dv.setUint32(e + 8, extra, true); at = extra; extra += size[type] * count; }
      for (let k = 0; k < count; k++) {
        const v = vals[k];
        if (type === 2) u8[at + k] = v.charCodeAt(0);
        else if (type === 3) dv.setUint16(at + k * 2, v, true);
        else if (type === 4) dv.setUint32(at + k * 4, v, true);
        else dv.setFloat64(at + k * 8, v, true);
      }
    });
    pos = (extra + 7) & ~7;
    dv.setUint32(start + 2 + entries.length * 12, l < LEVELS.length - 1 ? pos : 0, true);
  });
  if (pos > DATA_START) throw new Error('Cabecera demasiado grande');
  const tiles = [];
  LEVELS.forEach(([w, h], l) => {
    const across = Math.ceil(w / TILE);
    for (let k = 0; k < tileCounts[l]; k++) tiles.push({ l, tx: k % across, ty: Math.floor(k / across) });
  });
  return { bytes: u8, tiles, size: DATA_START + tiles.length * TILE_BYTES };
}

let cachedHeader = null;
const proj = laea(GEO);

/**
 * Fichero virtual. valueAt(lat, lon) devuelve dBZ (o NaN si no hay eco);
 * bounds {lat0, lat1, lon0, lon1} acota dónde puede haberlo.
 */
function operaFile(valueAt, bounds) {
  const h = cachedHeader || (cachedHeader = header());
  const made = new Map();
  function tileBytes(index) {
    if (made.has(index)) return made.get(index);
    const { l, tx, ty } = h.tiles[index];
    const sx = LEVELS[0][0] / LEVELS[l][0], sy = LEVELS[0][1] / LEVELS[l][1];
    const f = new Float32Array(TILE * TILE).fill(NaN);
    // Centro del píxel (c, r) del nivel; la esquina de la imagen está en (−500, 500) m.
    const ll = (c, r) => proj.inverse((c + 0.5) * sx * 1000 - 500, 500 - (r + 0.5) * sy * 1000);
    const corners = [[0, 0], [TILE, 0], [0, TILE], [TILE, TILE], [TILE / 2, 0], [TILE / 2, TILE], [0, TILE / 2], [TILE, TILE / 2]]
      .map(([c, r]) => ll(tx * TILE + c, ty * TILE + r));
    const la = corners.map((p) => p.lat), lo = corners.map((p) => p.lon);
    const hit = !bounds || (Math.max(...la) >= bounds.lat0 && Math.min(...la) <= bounds.lat1 && Math.max(...lo) >= bounds.lon0 && Math.min(...lo) <= bounds.lon1);
    for (let r = 0; r < TILE; r++) {
      const row = ty * TILE + r;
      for (let c = 0; c < TILE; c++) {
        const col = tx * TILE + c;
        if (col >= LEVELS[l][0] || row >= LEVELS[l][1]) { f[r * TILE + c] = NODATA; continue; }
        if (!hit) continue;
        const p = ll(col, row);
        f[r * TILE + c] = valueAt(p.lat, p.lon);
      }
    }
    const out = new Uint8Array(f.buffer);
    made.set(index, out);
    if (made.size > 12) made.delete(made.keys().next().value);
    return out;
  }
  return {
    size: h.size,
    read(start, end) {
      end = Math.min(end, h.size - 1);
      const out = new Uint8Array(Math.max(0, end - start + 1));
      if (start < DATA_START) out.set(h.bytes.subarray(start, Math.min(end + 1, DATA_START)));
      for (let i = Math.max(0, Math.floor((start - DATA_START) / TILE_BYTES)); i < h.tiles.length; i++) {
        const t0 = DATA_START + i * TILE_BYTES;
        if (t0 > end) break;
        const a = Math.max(start, t0), b = Math.min(end + 1, t0 + TILE_BYTES);
        if (a < b) out.set(tileBytes(i).subarray(a - t0, b - t0), a - start);
      }
      return out;
    }
  };
}

module.exports = { operaFile, GEO, LEVELS };
