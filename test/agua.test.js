'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const CUENCAS = require('../src/shared/cuencas');
const lib = () => import(pathToFileURL(path.join(__dirname, '../scripts/agua/lib.mjs')).href);

test('cuencas: peninsulares y Baleares, con los ámbitos del Boletín Hidrológico', () => {
  const ids = CUENCAS.basins.map((b) => b.id);
  assert.equal(new Set(ids).size, 16);
  assert.ok(ids.includes('ES091') && ids.includes('ES110') && !ids.some((id) => id.startsWith('ES12')));
  const ambitos = CUENCAS.basins.flatMap((b) => b.ambitos);
  assert.equal(ambitos.length, 16, 'los 16 ámbitos del boletín');
  assert.ok(CUENCAS.basins.find((b) => b.id === 'ES017').ambitos.includes('Cuencas Internas del País Vasco'));
  const duero = CUENCAS.basins.find((b) => b.id === 'ES020');
  assert.ok(Math.abs(duero.areaKm2 - 78859) / 78859 < 0.01, `Duero ${duero.areaKm2} km²`);
});

test('máscaras: los píxeles de 2 km de cada cuenca suman su superficie', async () => {
  const { buildMasks, GRID } = await lib();
  const m = buildMasks(CUENCAS.basins);
  const px = (GRID.size / 1000) ** 2;
  for (const b of m.basins) {
    const area = CUENCAS.basins.find((x) => x.id === b.id).areaKm2;
    if (area < 4000) continue; // en las pequeñas pesa más el borde
    assert.ok(Math.abs(b.pixels.length * px - area) / area < 0.02, `${b.id}: ${b.pixels.length * px} frente a ${area} km²`);
  }
  // Ningún píxel en dos cuencas.
  const seen = new Set();
  for (const b of m.basins) for (const i of b.pixels) { assert.ok(!seen.has(i), `píxel ${i} repetido`); seen.add(i); }
});

test('lluvia: media por cuenca, cobertura y suma de horas', async () => {
  const { basinHour, sumHours } = await lib();
  const basins = [{ id: 'A' }, { id: 'B' }];
  const masks = { basins: [{ id: 'A', pixels: Int32Array.from([0, 1, 2, 3]) }, { id: 'B', pixels: Int32Array.from([4, 5, 6, 7]) }] };
  const h1 = basinHour((i) => (i < 4 ? [2, 4, NaN, 0][i] : NaN), masks);
  assert.deepEqual(h1.A, [2, 0.75]);
  assert.deepEqual(h1.B, [null, 0], 'sin datos: no cuenta');
  const h2 = basinHour((i) => (i < 4 ? 1 : 3), masks);
  const sum = sumHours([h1, h2], 1, basins);
  assert.equal(sum.A[0], 3);
  // B solo tiene una de dos horas: no llega al 80 % y queda sin valor.
  assert.equal(sum.B[0], null);
});

test('año hidrológico: empieza el 1 de octubre', async () => {
  const { hydroYearStart } = await lib();
  assert.equal(hydroYearStart(Date.UTC(2026, 9, 8) / 1000), '2026-10-01');
  assert.equal(hydroYearStart(Date.UTC(2026, 8, 30) / 1000), '2025-10-01');
});

test('embalses: reserva por cuenca, semana anterior, hace un año y lista', async () => {
  const { summarizeReservoirs } = await lib();
  const list = [
    { id: 'ES017', ambitos: ['Cantábrico Oriental', 'Cuencas Internas del País Vasco'] },
    { id: 'ES030', ambitos: ['Tajo'] }
  ];
  const rows = [];
  const add = (date, ambito, name, cap, vol, elec = 0) => rows.push({
    FECHA: new Date(date), AMBITO_NOMBRE: ambito, EMBALSE_NOMBRE: name,
    AGUA_TOTAL: String(cap).replace('.', ','), AGUA_ACTUAL: String(vol).replace('.', ','), ELECTRICO_FLAG: String(elec)
  });
  for (const [date, f] of [['2025-10-07', 0.3], ['2026-09-29', 0.5], ['2026-10-06', 0.6]]) {
    add(date, 'Tajo', 'Grande', 1000, 1000 * f);
    add(date, 'Tajo', 'Pequeño', 100, 100 * f, 1);
    add(date, 'Cantábrico Oriental', 'Norte', 50, 50 * f);
    add(date, 'Cuencas Internas del País Vasco', 'Vasco', 50, 50 * f);
    add(date, 'Otra cuenca', 'X', 999, 999);
  }
  const out = summarizeReservoirs(rows, list);
  assert.equal(out.date, '2026-10-06');
  assert.equal(out.basins.ES030.pct, 60);
  assert.equal(out.basins.ES030.prevPct, 50);
  assert.equal(out.basins.ES030.lastYearPct, 30);
  assert.equal(out.basins.ES017.n, 2, 'el País Vasco va con el Cantábrico Oriental');
  assert.deepEqual(out.basins.ES030.list.map((x) => x.name), ['Grande', 'Pequeño']);
  assert.equal(out.basins.ES030.list[1].elec, true);
  assert.equal(out.basins.ES030.list[0].prev, 500);
  assert.equal(out.total.cap, 1200, 'lo que no es de ninguna cuenca no cuenta');
  assert.deepEqual(out.weekDates, ['2025-10-07', '2026-09-29', '2026-10-06']);
});
