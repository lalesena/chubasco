// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CL = require('../src/shared/clima');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
// Historia de 3 años (2023-2025) con 10 mm cada mes y 15 °C; nov-dic de 2023 sin datos.
const hist = () => {
  const n = 36, a = (v) => Array.from({ length: n }, () => v);
  const H = { m0: '2023-01', complete: true, prec: a(10), cov: a(100), tmean: a(15), tmax: a(20), rainDays: a(3) };
  H.prec[10] = H.prec[11] = H.tmean[10] = H.tmean[11] = H.cov[10] = H.cov[11] = null;
  return H;
};

test('clima: índices de mes', () => {
  assert.equal(CL.mKey(CL.mIdx('1920-01')), '1920-01');
  assert.equal(CL.mKey(CL.mIdx('2026-10') + 3), '2027-01');
  assert.equal(CL.dim(CL.mIdx('2024-02')), 29);
  assert.equal(CL.dim(CL.mIdx('2025-02')), 28);
});

test('clima: años naturales, con su cobertura', () => {
  const Y = CL.yearly(hist(), 'prec', 'sum');
  assert.equal(Y.y0, 2023);
  assert.deepEqual(Y.v, [100, 120, 120]);
  near(Y.cov[0], 304 / 365); // sin noviembre ni diciembre
  assert.equal(Y.cov[1], 1);
  // La media pondera por los días del mes; un año sin ningún mes sale nulo.
  assert.equal(CL.yearly(hist(), 'tmean', 'mean').v[0], 15);
  assert.equal(CL.yearly({ m0: '2020-01', prec: [null, null] }, 'prec', 'sum').v[0], null);
  assert.equal(CL.yearly(hist(), 'hr', 'mean'), null);
});

test('clima: la cobertura de la lluvia sale de cov; la de las medias, de si hay dato', () => {
  const H = hist();
  H.cov[0] = 50; // enero medido a medias
  near(CL.yearly(H, 'prec', 'sum').cov[0], (304 - 15.5) / 365);
  near(CL.yearly(H, 'tmean', 'mean').cov[0], 304 / 365);
  // Máximo y mínimo por año.
  const M = { m0: '2020-11', prec: [1, 9, 4, 2, 7], cov: [100, 100, 100, 100, 100] };
  assert.deepEqual(CL.yearly(M, 'prec', 'max').v, [9, 7]);
  assert.deepEqual(CL.yearly(M, 'prec', 'min').v, [1, 2]);
});

test('clima: el año más alto y el más bajo solo cuentan años completos', () => {
  const Y = { y0: 2000, v: [900, 500, 300, 700], cov: [0.4, 1, 1, 0.95] };
  assert.deepEqual(CL.extremes(Y), { hi: [2003, 700], lo: [2002, 300] });
  assert.equal(CL.extremes({ y0: 2000, v: [1, 2], cov: [0.2, 0.3] }), null);
  assert.equal(CL.extremes(null), null);
});

const N = {
  period: '1991-2020',
  months: {
    prec: [50, 40, 40, 45, 40, 25, 10, 12, 35, 55, 60, 55],
    precQ: [[20, 15, 15, 20, 15, 8, 2, 3, 12, 22, 25, 22], [35, 30, 30, 35, 30, 15, 5, 6, 25, 40, 45, 40], [55, 45, 45, 50, 45, 28, 11, 14, 40, 60, 66, 60], [80, 65, 65, 70, 65, 40, 20, 22, 60, 90, 95, 85]],
    tmean: [5, 6, 9, 11, 15, 20, 24, 24, 19, 14, 8, 5]
  }
};

test('clima: clase de la lluvia de un mes por quintiles', () => {
  const k = (mm) => CL.rainClass(N, 0, mm); // enero: 20, 35, 55, 80
  assert.deepEqual([5, 19.9, 20, 34, 35, 54, 55, 79, 80, 300].map(k), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(CL.rainClass({ months: { prec: [1] } }, 0, 5), null);
  assert.equal(CL.rainClass(N, 0, null), null);
});

test('clima: el último mes entero es el anterior, salvo si ya acabó', () => {
  assert.equal(CL.lastComplete('2026-10-04'), CL.mIdx('2026-09'));
  assert.equal(CL.lastComplete('2026-10-31'), CL.mIdx('2026-10'));
  assert.equal(CL.lastComplete('2026-01-02'), CL.mIdx('2025-12'));
});

test('clima: comparación con lo normal (mes en curso, año hidrológico y último mes)', () => {
  // Desde oct 2025: 60 en octubre, 10 en noviembre... y hasta el 15 de febrero.
  const H = { m0: '2025-10', cov: [100, 100, 100, 100, 50], prec: [60, 66, 55, 40, 20], tmean: [14, 8, 5, 7.5, null] };
  const c = CL.compare(H, N, '2026-02-15');
  // Febrero hasta el 15: 20 mm de 40 normales.
  assert.equal(c.month.mm, 20);
  near(c.month.pct, 50);
  assert.equal(c.month.day, 15);
  // Año hidrológico: normal de oct-ene (55+60+55+50 = 220) más 15/28 de febrero (40).
  assert.equal(c.hydro.since, '2025-10');
  near(c.hydro.mm, 241);
  near(c.hydro.normal, 220 + 40 * (15 / 28));
  near(c.hydro.pct, (100 * 241) / (220 + 40 * (15 / 28)));
  assert.ok(c.hydro.cov > 0.9);
  // Enero: 40 mm, entre los quintiles 35 y 55 (clase 2, «normal»); temperatura 7,5 contra 5.
  assert.equal(c.last.key, '2026-01');
  assert.equal(c.last.rain.mm, 40);
  assert.equal(c.last.rain.cls, 2);
  near(c.last.rain.pct, 80);
  near(c.last.temp.delta, 2.5);
});

test('clima: sin datos suficientes no sale nada que engañe', () => {
  assert.deepEqual(CL.compare(null, N, '2026-02-15'), { month: null, hydro: null, last: null });
  // Los primeros días del mes todavía no dicen nada del mes.
  const H = { m0: '2026-02', cov: [10], prec: [3] };
  assert.equal(CL.compare(H, N, '2026-02-02').month, null);
  // Un año hidrológico con casi todo sin medir no se compara.
  assert.equal(CL.compare({ m0: '2026-02', cov: [100], prec: [30] }, N, '2026-02-15').hydro, null);
  // En octubre el año hidrológico es el propio mes: no se repite.
  assert.equal(CL.compare({ m0: '2026-10', cov: [50], prec: [20] }, N, '2026-10-15').hydro, null);
  // Un último mes medido a medias no se clasifica.
  const P = CL.compare({ m0: '2026-01', cov: [40, 100], prec: [5, 3] }, N, '2026-02-15');
  assert.equal(P.last, null);
});
