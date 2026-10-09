// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Lluvia y temperatura del modo «Previsión»: el formato en que se publican
 * (scripts/viento/datos.mjs) junto al viento de cada hora, y lo que la app y
 * la web hacen con ellas (leerlas, interpolar en un punto y colores).
 *
 * Van aparte del viento (windgrid.js) para que los ficheros fNNN.gz no cambien
 * y las versiones ya instaladas sigan leyéndolos: cada hora tiene además un
 * fichero <pasada>/mNNN.gz con dos campos de rows × cols bytes (la misma
 * rejilla del modelo, de norte a sur y de oeste a este):
 *
 *  - lluvia: la media en mm/h del tramo que acaba en esa hora (1 h o 3 h según
 *    el modelo y la hora; su duración va en `span` en index.json). Un byte q
 *    sin signo por punto, no lineal para tener detalle con poca lluvia:
 *    mm/h = (q / rainK)², de 0 a 104 mm/h con rainK = 25 (0,0016 mm/h el
 *    primer escalón, 0,1 mm/h hacia q = 8 y 0,5 mm/h a partir de q = 18).
 *  - temperatura a 2 m: q sin signo, °C = tempMin + q · tempStep (de −60 a
 *    +60 °C en pasos de 0,5 °C: q de 0 a 240).
 *
 * Como en el viento, cada fila va en diferencias con el valor de su izquierda
 * (módulo 256) y el fichero entero, comprimido con gzip. Los parámetros van en
 * `met` de index.json ({ v: 1, rainK, tempMin, tempStep }); si falta, esa
 * pasada no tiene lluvia ni temperatura.
 *
 * Altura del terreno del modelo (orografía): la temperatura a 2 m del modelo
 * vale a la altura de SU terreno (una celda de 25 km alisa las montañas), y
 * para corregirla en un punto más alto o más bajo hace falta saberla. Se
 * publica una vez por modelo, aparte de las horas, porque no cambia con la
 * pasada: <modelo>/orog.gz, en la misma rejilla. Son rows × cols valores de
 * 16 bits con signo en metros / `step` (5 m por unidad: de −163 a +163 km de
 * sobra, y el mar es 0). Igual que lo demás, cada fila va en diferencias con el
 * valor de su izquierda (módulo 65536), y esas diferencias se guardan en dos
 * planos de bytes seguidos, primero los n bajos y luego los n altos (así comprime
 * mejor), y el fichero entero con gzip. Los parámetros van en `orogMeta` de
 * index.json ({ v: 1, step }) y el nombre del fichero en `orog`; si faltan, esa
 * pasada no trae la altura del terreno (los clientes antiguos los ignoran).
 *
 * Módulo UMD: require() en Node y window.RA_METGRID en la interfaz.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./windgrid'), require('./palette'));
  else root.RA_METGRID = factory(root.RA_WINDGRID, root.RA_PALETTE);
})(typeof self !== 'undefined' ? self : this, function (WG, P) {
  'use strict';

  const META = { v: 1, rainK: 25, tempMin: -60, tempStep: 0.5 };
  const TEMP_Q_MAX = 240;
  // Altura del terreno del modelo: metros por unidad de los valores de 16 bits.
  const OROG = { v: 1, step: 5 };
  // Por debajo de esto no se considera que llueva: es el mismo umbral del radar (7 dBZ ≈ 0,1 mm/h).
  const RAIN_MIN = 0.1;

  // ----------------------------------------------------------------
  // Formato

  /** rain (mm/h) y temp (°C): Float32Array de rows × cols, de norte a sur. */
  function encode({ rain, temp }, grid, meta = META) {
    const n = grid.rows * grid.cols;
    const out = new Uint8Array(2 * n);
    for (let f = 0; f < 2; f++) {
      for (let r = 0; r < grid.rows; r++) {
        let prev = 0;
        for (let c = 0; c < grid.cols; c++) {
          const i = r * grid.cols + c;
          let q;
          if (f === 0) {
            const x = rain[i];
            q = x > 0 ? Math.min(255, Math.round(Math.sqrt(x) * meta.rainK)) : 0;
          } else {
            const x = temp[i];
            // Sin dato, la del punto de su izquierda (o 15 °C al principio de la fila).
            q = Number.isFinite(x) ? Math.max(0, Math.min(TEMP_Q_MAX, Math.round((x - meta.tempMin) / meta.tempStep))) : c ? prev : Math.round((15 - meta.tempMin) / meta.tempStep);
          }
          out[f * n + i] = (q - prev) & 255;
          prev = q;
        }
      }
    }
    return out;
  }

  function decode(bytes, grid, meta = META) {
    const n = grid.rows * grid.cols;
    if (!bytes || bytes.length !== 2 * n) throw new Error(`Rejilla de lluvia y temperatura con ${bytes ? bytes.length : 0} bytes (se esperaban ${2 * n})`);
    const field = (f, conv) => {
      const out = new Float32Array(n);
      for (let r = 0; r < grid.rows; r++) {
        let q = 0;
        for (let c = 0; c < grid.cols; c++) {
          const i = r * grid.cols + c;
          q = (q + bytes[f * n + i]) & 255;
          out[i] = conv(q);
        }
      }
      return out;
    };
    const rain = field(0, (q) => (q / meta.rainK) ** 2);
    const temp = field(1, (q) => meta.tempMin + q * meta.tempStep);
    return { rain, temp };
  }

  /** Altura del terreno (m, Float32Array de rows × cols, de norte a sur) en el formato de orog.gz (sin comprimir). */
  function encodeOrog(height, grid, meta = OROG) {
    const n = grid.rows * grid.cols;
    const out = new Uint8Array(2 * n);
    for (let r = 0; r < grid.rows; r++) {
      let prev = 0;
      for (let c = 0; c < grid.cols; c++) {
        const i = r * grid.cols + c;
        const x = height[i];
        // Sin dato, la del punto de su izquierda (o 0 m, el mar, al principio de la fila).
        const q = Number.isFinite(x) ? Math.max(-32768, Math.min(32767, Math.round(x / meta.step))) : c ? prev : 0;
        const d = (q - prev) & 0xffff;
        out[i] = d & 255;
        out[n + i] = d >> 8;
        prev = q;
      }
    }
    return out;
  }

  /** Lo contrario: altura del terreno (m) como Float32Array de rows × cols. */
  function decodeOrog(bytes, grid, meta = OROG) {
    const n = grid.rows * grid.cols;
    if (!bytes || bytes.length !== 2 * n) throw new Error(`Rejilla de altura del terreno con ${bytes ? bytes.length : 0} bytes (se esperaban ${2 * n})`);
    const out = new Float32Array(n);
    for (let r = 0; r < grid.rows; r++) {
      let q = 0;
      for (let c = 0; c < grid.cols; c++) {
        const i = r * grid.cols + c;
        q = (q + (bytes[n + i] << 8 | bytes[i])) & 0xffff;
        out[i] = (q > 32767 ? q - 65536 : q) * meta.step;
      }
    }
    return out;
  }

  /** Lluvia (mm/h) y temperatura (°C) en un punto, o null si cae fuera de la rejilla. */
  function sample(step, grid, lat, lon) {
    const p = WG.cell(grid, lat, lon);
    if (!p || !step) return null;
    return { rain: Math.max(0, WG.bilinear(step.rain, grid, p[0], p[1])), temp: WG.bilinear(step.temp, grid, p[0], p[1]) };
  }

  // ----------------------------------------------------------------
  // Colores de la lluvia: los del radar (palette.js), con el mismo recorte
  // de ruido (por debajo de RAIN_MIN no se pinta nada).

  const pack = ([r, g, b, a]) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0; // ImageData en little-endian
  let rainDbz = null;
  function rainRgba(rate) {
    if (!rainDbz) {
      rainDbz = new Map();
      for (const e of P._table) if (e.kind === P.KIND_RAIN && !rainDbz.has(e.dbz)) rainDbz.set(e.dbz, e.rgba);
    }
    return rainDbz.get(Math.max(-10, Math.min(70, Math.floor(P.rateToDbz(rate, P.KIND_RAIN)))));
  }
  /** Tabla de colores RGBA empaquetados por escalón q de la lluvia (mm/h = (q / rainK)²). */
  function rainColorTable(meta = META) {
    const lut = new Uint32Array(256);
    for (let q = 1; q < 256; q++) {
      const rate = (q / meta.rainK) ** 2;
      if (rate >= RAIN_MIN) lut[q] = pack(rainRgba(rate));
    }
    return lut;
  }
  const rainIndex = (mmh, meta = META) => (mmh > 0 ? Math.min(255, Math.round(Math.sqrt(mmh) * meta.rainK)) : 0);
  /** Color CSS de una intensidad (para las barras de la gráfica), el de la leyenda del radar. */
  const rainCss = (mmh) => P.cssFor(Math.max(10, P.rateToDbz(mmh, P.KIND_RAIN)), P.KIND_RAIN);
  /** El mismo color con su transparencia, como se pinta en el mapa (para la leyenda). */
  function rainRgbaCss(mmh) {
    const [r, g, b, a] = rainRgba(mmh);
    return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  }

  // ----------------------------------------------------------------
  // Colores de la temperatura (°C): escala divergente, del violeta y el azul
  // del frío a un neutro cálido hacia los 15 °C y de ahí al amarillo, el naranja
  // y el rojo oscuro del calor.

  const TEMP_ANCHORS = [
    [-25, [98, 56, 152]], [-15, [62, 84, 178]], [-5, [52, 130, 204]], [3, [92, 174, 218]],
    [9, [150, 208, 222]], [15, [234, 232, 206]], [20, [250, 216, 110]], [25, [246, 176, 60]],
    [30, [232, 122, 44]], [35, [206, 66, 42]], [40, [158, 34, 52]], [46, [96, 22, 58]]
  ];
  function tempColor(c) {
    if (!(c > TEMP_ANCHORS[0][0])) return TEMP_ANCHORS[0][1];
    for (let k = 1; k < TEMP_ANCHORS.length; k++) {
      const [v1, c1] = TEMP_ANCHORS[k];
      if (c <= v1) {
        const [v0, c0] = TEMP_ANCHORS[k - 1];
        const f = (c - v0) / (v1 - v0);
        return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * f));
      }
    }
    return TEMP_ANCHORS[TEMP_ANCHORS.length - 1][1];
  }
  /** Tabla de colores RGBA empaquetados por escalón q de la temperatura (°C = tempMin + q · tempStep). */
  function tempColorTable(meta = META, alpha = 255) {
    const lut = new Uint32Array(TEMP_Q_MAX + 1);
    for (let q = 0; q < lut.length; q++) {
      const [r, g, b] = tempColor(meta.tempMin + q * meta.tempStep);
      lut[q] = ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    return lut;
  }
  const tempIndex = (c, meta = META) => Math.max(0, Math.min(TEMP_Q_MAX, Math.round((c - meta.tempMin) / meta.tempStep)));
  const tempCss = (c) => `rgb(${tempColor(c).join(',')})`;

  return { META, RAIN_MIN, TEMP_Q_MAX, OROG, encode, decode, encodeOrog, decodeOrog, sample, rainColorTable, rainIndex, rainCss, rainRgbaCss, TEMP_ANCHORS, tempColor, tempColorTable, tempIndex, tempCss };
});
