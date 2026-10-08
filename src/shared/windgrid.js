// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Rejilla de viento del modo «Viento»: el formato en que se publica cada hora
 * de la previsión (scripts/viento/datos.mjs) y lo que la app y la web hacen
 * con ella (leerla, interpolar en un punto, escala Beaufort y colores).
 *
 * Cada hora es un fichero .gz con tres campos de rows × cols bytes, de norte a
 * sur y de oeste a este: u y v (m/s, con signo) y racha (m/s, sin signo), en
 * pasos de `scale` m/s. Cada fila va en diferencias con el valor de su
 * izquierda (el viento cambia poco de un punto al siguiente y así se comprime
 * mucho mejor).
 *
 * Módulo UMD: require() en Node y window.RA_WINDGRID en la interfaz.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RA_WINDGRID = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Europa (la zona del radar OPERA), con Canarias, Madeira y casi todas las Azores.
  const DOMAIN = { west: -32, east: 45, south: 27, north: 72, step: 0.25 };
  // ICON-EU a su resolución completa (0,0625°, unos 7 km), solo en la península,
  // Baleares, el sur de Francia y el norte de Marruecos: toda Europa pesaría
  // unas 15 veces más. Canarias queda fuera de la zona del modelo (empieza en 29,5° N).
  const ICON_DOMAIN = { west: -10.5, east: 6, south: 34.5, north: 46, step: 0.0625 };
  const SCALE = 0.5; // m/s por unidad

  function gridOf(d = DOMAIN) {
    return {
      west: d.west, north: d.north, step: d.step,
      cols: Math.round((d.east - d.west) / d.step) + 1,
      rows: Math.round((d.north - d.south) / d.step) + 1
    };
  }

  // Modelos que se publican (en viento/<id>/), en el orden del selector.
  const MODELS = [
    { id: 'ecmwf', name: 'ECMWF', grid: gridOf(DOMAIN) },
    { id: 'icon-eu', name: 'ICON-EU', grid: gridOf(ICON_DOMAIN) },
    { id: 'gfs', name: 'GFS', grid: gridOf(DOMAIN) }
  ];

  // ----------------------------------------------------------------
  // Formato

  /** u, v, gust: Float32Array (m/s) de rows × cols, de norte a sur. */
  function encode({ u, v, gust }, grid, scale = SCALE) {
    const n = grid.rows * grid.cols;
    const out = new Uint8Array(3 * n);
    const fields = [[u, -127, 127], [v, -127, 127], [gust, 0, 255]];
    fields.forEach(([src, lo, hi], f) => {
      for (let r = 0; r < grid.rows; r++) {
        let prev = 0;
        for (let c = 0; c < grid.cols; c++) {
          const i = r * grid.cols + c;
          const x = src[i];
          const q = Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x / scale))) : 0;
          out[f * n + i] = (q - prev) & 255;
          prev = q;
        }
      }
    });
    return out;
  }

  function decode(bytes, grid, scale = SCALE) {
    const n = grid.rows * grid.cols;
    if (!bytes || bytes.length !== 3 * n) throw new Error(`Rejilla de viento con ${bytes ? bytes.length : 0} bytes (se esperaban ${3 * n})`);
    const field = (f, signed) => {
      const out = new Float32Array(n);
      for (let r = 0; r < grid.rows; r++) {
        let q = 0;
        for (let c = 0; c < grid.cols; c++) {
          const i = r * grid.cols + c;
          q = (q + bytes[f * n + i]) & 255;
          out[i] = (signed && q > 127 ? q - 256 : q) * scale;
        }
      }
      return out;
    };
    const u = field(0, true), v = field(1, true), gust = field(2, false);
    const speed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      speed[i] = Math.hypot(u[i], v[i]);
      // La racha nunca es menor que el viento medio (el redondeo podría dejarla un poco por debajo).
      if (gust[i] < speed[i]) gust[i] = speed[i];
    }
    return { u, v, gust, speed };
  }

  /** Descomprime un .gz con DecompressionStream (navegador y Node 18+). */
  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  /** Como gunzip, pero deja tal cual lo que ya llegue descomprimido (sin la firma 1f 8b). */
  async function inflate(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return b[0] === 0x1f && b[1] === 0x8b ? gunzip(b) : b;
  }

  // ----------------------------------------------------------------
  // Interpolación

  /** Posición continua (columna, fila) de un punto, o null si cae fuera. */
  function cell(grid, lat, lon) {
    const c = (lon - grid.west) / grid.step;
    const r = (grid.north - lat) / grid.step;
    if (!(c >= 0 && r >= 0 && c <= grid.cols - 1 && r <= grid.rows - 1)) return null;
    return [c, r];
  }

  /** Valor bilineal de `arr` en (c, r). */
  function bilinear(arr, grid, c, r) {
    const c0 = Math.min(grid.cols - 2, Math.floor(c)), r0 = Math.min(grid.rows - 2, Math.floor(r));
    const fc = c - c0, fr = r - r0;
    const i = r0 * grid.cols + c0;
    const a = arr[i], b = arr[i + 1], d = arr[i + grid.cols], e = arr[i + grid.cols + 1];
    return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
  }

  /**
   * Viento en un punto: velocidad y racha en m/s y la dirección de la que
   * sopla (grados, 0 = del norte, 90 = del este). null fuera de la rejilla.
   */
  function sample(step, grid, lat, lon) {
    const p = cell(grid, lat, lon);
    if (!p || !step) return null;
    const u = bilinear(step.u, grid, p[0], p[1]);
    const v = bilinear(step.v, grid, p[0], p[1]);
    const speed = Math.hypot(u, v);
    const gust = Math.max(speed, bilinear(step.gust, grid, p[0], p[1]));
    const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    return { u, v, speed, gust, from };
  }

  // ----------------------------------------------------------------
  // Escala Beaufort (m/s, límite inferior de cada grado)

  const BEAUFORT = [0, 0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  function beaufort(ms) {
    let b = 0;
    while (b < 12 && ms >= BEAUFORT[b + 1]) b++;
    return b;
  }

  // ----------------------------------------------------------------
  // Colores por velocidad (m/s): de la calma (azul pizarra) al temporal
  // (magenta y morado), con los cambios de tono en los grados de Beaufort.

  const ANCHORS = [
    [0, [84, 104, 158]], [2, [62, 128, 182]], [4, [52, 160, 168]], [6, [66, 170, 98]],
    [8, [142, 190, 62]], [10, [226, 204, 58]], [12.5, [240, 160, 46]], [15, [230, 100, 44]],
    [18, [205, 44, 58]], [22, [174, 36, 110]], [27, [124, 44, 156]], [33, [86, 44, 140]],
    [42, [222, 210, 236]]
  ];
  function color(ms) {
    if (!(ms > 0)) return ANCHORS[0][1];
    for (let k = 1; k < ANCHORS.length; k++) {
      const [v1, c1] = ANCHORS[k];
      if (ms <= v1) {
        const [v0, c0] = ANCHORS[k - 1];
        const f = (ms - v0) / (v1 - v0);
        return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * f));
      }
    }
    return ANCHORS[ANCHORS.length - 1][1];
  }
  const LUT_STEP = 0.25; // m/s
  const LUT_MAX = 48;
  /** Tabla de colores RGBA empaquetados (ImageData en little-endian) cada 0,25 m/s. */
  function colorTable(alpha = 255) {
    const lut = new Uint32Array(Math.round(LUT_MAX / LUT_STEP) + 1);
    for (let i = 0; i < lut.length; i++) {
      const [r, g, b] = color(i * LUT_STEP);
      lut[i] = ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    return lut;
  }
  const css = (ms) => `rgb(${color(ms).join(',')})`;

  return { DOMAIN, ICON_DOMAIN, MODELS, SCALE, gridOf, encode, decode, gunzip, inflate, cell, bilinear, sample, BEAUFORT, beaufort, ANCHORS, color, colorTable, LUT_STEP, LUT_MAX, css };
});
