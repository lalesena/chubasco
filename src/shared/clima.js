// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/* Cuentas sobre la historia larga de un pluviómetro de AEMET: los campos history,
 * normals y records de agua/pluvio/<id>.json (forma en scripts/agua/historico.mjs).
 * Resumen por años, comparación con lo normal, clase por quintiles… Sin DOM ni
 * unidades: todo en mm, °C, %, m/s y h, y los meses son 'YYYY-MM' o un índice
 * absoluto (año × 12 + mes 0-11). Las usa la ficha de agua.js y las pruebas. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RA_CLIMA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Variables que cuentan días de lluvia medida: `cov` dice cuánto del mes se midió.
  const RAIN = new Set(['prec', 'rainDays', 'rainDays1', 'precMax']);
  const COMPLETE = 0.9; // cobertura mínima para dar un año por completo
  const MONTH_OK = 0.8; // y para un mes

  const mIdx = (key) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
  const mKey = (i) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
  const dim = (i) => new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)).getUTCDate();

  // Valor de una variable de history en el mes `i` (índice absoluto), o null.
  function at(H, key, i) {
    const a = H && H[key];
    const k = i - mIdx(H.m0);
    return a && k >= 0 && k < a.length && a[k] !== undefined ? a[k] : null;
  }
  // Qué parte del mes se midió (0-1) para esa variable: la lluvia dice `cov`; el resto, sí o no.
  function cover(H, key, i) {
    if (at(H, key, i) === null) return 0;
    if (!RAIN.has(key) || !H.cov) return 1;
    const c = at(H, 'cov', i);
    return c === null ? 1 : c / 100;
  }
  // Meses que tiene la serie de esas variables (el último con alguna).
  const length = (H, keys) => Math.max(0, ...keys.map((k) => (H && H[k] ? H[k].length : 0)));

  // Resumen por años naturales de la variable mensual `key`. how: 'sum' | 'mean' | 'max' | 'min'.
  // { y0, v: [por año, null si no hay ningún mes], cov: [0-1, parte del año medida] } o null.
  function yearly(H, key, how) {
    const a = H && H[key];
    if (!a || !a.length) return null;
    const f0 = mIdx(H.m0), y0 = Math.floor(f0 / 12), y1 = Math.floor((f0 + a.length - 1) / 12);
    const v = [], cov = [];
    for (let y = y0; y <= y1; y++) {
      let acc = null, w = 0, seen = 0, total = 0;
      for (let m = 0; m < 12; m++) {
        const i = y * 12 + m, d = dim(i), x = at(H, key, i);
        total += d;
        if (x === null) continue;
        seen += d * cover(H, key, i);
        w += d;
        if (how === 'sum') acc = (acc === null ? 0 : acc) + x;
        else if (how === 'mean') acc = (acc === null ? 0 : acc) + x * d;
        else if (how === 'max') acc = acc === null ? x : Math.max(acc, x);
        else acc = acc === null ? x : Math.min(acc, x);
      }
      v.push(acc === null ? null : how === 'mean' ? acc / w : acc);
      cov.push(seen / total);
    }
    return { y0, v, cov };
  }

  // Año más alto y más bajo entre los años completos: { hi: [año, valor], lo: [año, valor] } o null.
  function extremes(Y) {
    if (!Y) return null;
    let hi = null, lo = null;
    Y.v.forEach((x, i) => {
      if (x === null || Y.cov[i] < COMPLETE) return;
      if (!hi || x > hi[1]) hi = [Y.y0 + i, x];
      if (!lo || x < lo[1]) lo = [Y.y0 + i, x];
    });
    return hi && lo && hi[0] !== lo[0] ? { hi, lo } : null;
  }

  // Clase de la lluvia de un mes (m: 0-11) según los quintiles de las normales:
  // 0 muy seco, 1 seco, 2 normal, 3 húmedo, 4 muy húmedo; null si faltan los límites.
  function rainClass(N, m, mm) {
    const Q = N && N.months && N.months.precQ;
    if (!Q || mm === null || mm === undefined) return null;
    const q = [0, 1, 2, 3].map((k) => (Q[k] ? Q[k][m] : null));
    return q.some((x) => x === null || x === undefined) ? null : q.filter((x) => mm >= x).length;
  }

  // Último mes terminado (índice) cuando los datos llegan al día `until` ('YYYY-MM-DD').
  function lastComplete(until) {
    const ci = mIdx(until);
    return Number(until.slice(8, 10)) >= dim(ci) ? ci : ci - 1;
  }

  // Cómo va la lluvia frente a lo normal al día `until` (el último con datos):
  //  month: el mes en curso hasta ahora · hydro: el año hidrológico (desde el 1 oct)
  //  last: el último mes entero, con su clase y la anomalía de temperatura.
  function compare(H, N, until) {
    const out = { month: null, hydro: null, last: null };
    if (!H || !N || !N.months) return out;
    const ci = mIdx(until), day = Number(until.slice(8, 10)), nrm = (k, i) => (N.months[k] ? N.months[k][i % 12] : null);
    const pct = (v, n) => (n > 0 ? (100 * v) / n : null);
    const full = lastComplete(until) === ci; // el mes ya acabó
    // Mes en curso (con unos días al menos; antes no dice nada).
    const mm = at(H, 'prec', ci), n0 = nrm('prec', ci);
    if (!full && day >= 3 && mm !== null && n0 !== null) out.month = { key: mKey(ci), day, mm, normal: n0, pct: pct(mm, n0) };
    // Año hidrológico: de octubre a hoy; lo normal, con el mes en curso a prorrata.
    const h0 = ci - ((ci % 12) + 3) % 12;
    if (ci > h0) {
      let sum = 0, normal = 0, seen = 0, days = 0, ok = true;
      for (let i = h0; i <= ci; i++) {
        const d = i === ci ? day : dim(i), x = at(H, 'prec', i), nn = nrm('prec', i);
        if (nn === null) { ok = false; break; }
        normal += nn * (d / dim(i));
        days += d;
        if (x !== null) { sum += x; seen += (i === ci ? Math.min(day, cover(H, 'prec', i) * dim(i)) : d * cover(H, 'prec', i)); }
      }
      if (ok && seen / days >= 0.5) out.hydro = { since: mKey(h0), mm: sum, normal, pct: pct(sum, normal), cov: seen / days };
    }
    // Último mes entero.
    const li = lastComplete(until), m = li % 12;
    const lm = cover(H, 'prec', li) >= MONTH_OK ? at(H, 'prec', li) : null, ln = nrm('prec', li);
    const tm = at(H, 'tmean', li), tn = nrm('tmean', li);
    const rainOk = lm !== null && ln !== null, tempOk = tm !== null && tn !== null;
    if (rainOk || tempOk) {
      out.last = {
        key: mKey(li),
        rain: rainOk ? { mm: lm, normal: ln, pct: pct(lm, ln), cls: rainClass(N, m, lm) } : null,
        temp: tempOk ? { t: tm, normal: tn, delta: tm - tn } : null
      };
    }
    return out;
  }

  return { RAIN, COMPLETE, MONTH_OK, mIdx, mKey, dim, at, cover, length, yearly, extremes, rainClass, lastComplete, compare };
});
