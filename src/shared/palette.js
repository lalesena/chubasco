// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Escala de colores por dBZ para el mapa, la leyenda y las gráficas, con
 * anclas cada 5 dBZ (los colores siguen la paleta «Universal Blue» publicada
 * por RainViewer; solo los colores, ningún dato suyo). Una escala para la
 * lluvia y otra para la nieve (la nieve la da el modelo, no el radar).
 *
 * Módulo UMD: se usa desde el proceso principal (require) y desde la
 * interfaz (<script>, expone window.RA_PALETTE).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RA_PALETTE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAIN_ANCHORS = [
    [-10, '63615914'], [-5, '726e612e'], [0, '827b6949'], [5, '92887164'],
    [10, 'cec08796'], [15, '88ddeeff'], [20, '00a3e0ff'], [25, '0077aaff'],
    [30, '005588ff'], [35, 'ffee00ff'], [40, 'ffaa00ff'], [45, 'ff4400ff'],
    [50, 'c10000ff'], [55, 'ffaaffff'], [60, 'ff77ffff'], [65, 'ffffffff'],
    [70, 'ffffffff']
  ];
  const SNOW_ANCHORS = [
    [-10, 'cfffff00'], [-5, 'cbffff3f'], [0, 'c7ffff7f'], [5, 'c3ffffbf'],
    [10, 'bfffffff'], [15, '9fdfffff'], [20, '7fbfffff'], [25, '5f9fffff'],
    [30, '4f8fffff'], [35, '3f7fffff'], [40, '2f6fffff'], [45, '1f5fffff'],
    [50, '0f4fffff'], [55, '003fffff'], [60, '002fffff'], [65, '001fffff'],
    [70, '000fffff']
  ];

  const KIND_NONE = 0;
  const KIND_RAIN = 1;
  const KIND_SNOW = 2;

  function hexToRgba(h) {
    return [
      parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16)
    ];
  }

  // Tabla de 1 dBZ interpolando entre anclas.
  function expand(anchors, kind) {
    const out = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const [d0, h0] = anchors[i];
      const [d1, h1] = anchors[i + 1];
      const c0 = hexToRgba(h0);
      const c1 = hexToRgba(h1);
      for (let d = d0; d < d1; d++) {
        const f = (d - d0) / (d1 - d0);
        out.push({
          dbz: d, kind,
          rgba: c0.map((v, k) => Math.round(v + (c1[k] - v) * f))
        });
      }
    }
    const last = anchors[anchors.length - 1];
    out.push({ dbz: last[0], kind, rgba: hexToRgba(last[1]) });
    // Las anclas exactas tienen prioridad (se colocan al principio).
    const exact = anchors.map(([d, h]) => ({ dbz: d, kind, rgba: hexToRgba(h) }));
    return exact.concat(out.filter((e) => !anchors.some(([d]) => d === e.dbz)));
  }

  const TABLE = expand(RAIN_ANCHORS, KIND_RAIN)
    .concat(expand(SNOW_ANCHORS, KIND_SNOW))
    .filter((e) => e.rgba[3] > 0);

  /** dBZ → mm/h (Marshall-Palmer para lluvia, Sekhon-Srivastava para nieve). */
  function dbzToRate(dbz, kind) {
    if (!isFinite(dbz)) return 0;
    const z = Math.pow(10, dbz / 10);
    if (kind === KIND_SNOW) return Math.pow(z / 2000, 0.5);
    return Math.pow(z / 200, 1 / 1.6);
  }

  /** mm/h → dBZ (inversa de dbzToRate). */
  function rateToDbz(rate, kind) {
    if (kind === KIND_SNOW) return 10 * Math.log10(2000 * rate * rate);
    return 10 * Math.log10(200 * Math.pow(rate, 1.6));
  }

  /** Umbrales de intensidad para las alarmas, en dBZ. */
  const LEVELS = {
    any: 10,       // ≈ 0,15 mm/h
    light: 18,     // ≈ 0,5 mm/h
    moderate: 29,  // ≈ 2,5 mm/h
    heavy: 39      // ≈ 10 mm/h
  };

  function levelOf(dbz) {
    if (!isFinite(dbz) || dbz < LEVELS.any) return 'none';
    if (dbz < LEVELS.light) return 'drizzle';
    if (dbz < LEVELS.moderate) return 'light';
    if (dbz < LEVELS.heavy) return 'moderate';
    if (dbz < 50) return 'heavy';
    return 'violent';
  }

  /** Escala para la leyenda: cada 5 dBZ, con su color en CSS. */
  function legend(kind) {
    const anchors = kind === KIND_SNOW ? SNOW_ANCHORS : RAIN_ANCHORS;
    return anchors
      .filter(([d]) => d >= 10 && d <= 65)
      .map(([d, h]) => {
        const [r, g, b, a] = hexToRgba(h);
        return { dbz: d, rate: dbzToRate(d, kind), css: `rgba(${r},${g},${b},${(a / 255).toFixed(3)})` };
      });
  }

  /** Color CSS aproximado para un dBZ (para gráficas y textos). */
  function cssFor(dbz, kind) {
    if (!isFinite(dbz)) return 'transparent';
    const anchors = kind === KIND_SNOW ? SNOW_ANCHORS : RAIN_ANCHORS;
    let pick = anchors[0];
    for (const a of anchors) if (a[0] <= dbz) pick = a;
    const [r, g, b] = hexToRgba(pick[1]);
    return `rgb(${r},${g},${b})`;
  }

  return {
    KIND_NONE, KIND_RAIN, KIND_SNOW, LEVELS,
    dbzToRate, rateToDbz, levelOf, legend, cssFor,
    _table: TABLE
  };
});
