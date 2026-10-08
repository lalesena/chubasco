// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
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

test('embalses: histórico de cada embalse (semana, años anteriores, meses, récords)', async () => {
  const { reservoirHistory, summarizeReservoirs } = await lib();
  const list = [{ id: 'ES030', ambitos: ['Tajo'] }, { id: 'ES020', ambitos: ['Duero'] }];
  const rows = [];
  // 12 años de boletines semanales (martes); el embalse "Grande" sube 2 puntos cada año
  // y en la semana 40 de cada año está a 30 + 2·año %.
  const start = Date.UTC(2014, 0, 7);
  const weeks = 52 * 12 + 40;
  for (let k = 0; k <= weeks; k++) {
    const d = new Date(start + k * 7 * 86400000);
    const year = Math.floor(k / 52.18);
    const pct = 30 + 2 * year + 10 * Math.sin((2 * Math.PI * (k % 52)) / 52);
    rows.push({ FECHA: d, AMBITO_NOMBRE: 'Tajo', EMBALSE_NOMBRE: 'Grande', AGUA_TOTAL: '200', AGUA_ACTUAL: String((2 * pct).toFixed(2)).replace('.', ','), ELECTRICO_FLAG: '0' });
    if (k > weeks - 20) rows.push({ FECHA: d, AMBITO_NOMBRE: 'Tajo', EMBALSE_NOMBRE: 'Nuevo', AGUA_TOTAL: '10', AGUA_ACTUAL: '5', ELECTRICO_FLAG: '0' });
    if (k < 100) rows.push({ FECHA: d, AMBITO_NOMBRE: 'Tajo', EMBALSE_NOMBRE: 'Viejo', AGUA_TOTAL: '10', AGUA_ACTUAL: '5', ELECTRICO_FLAG: '0' });
  }
  const h = reservoirHistory(rows, list);
  const s = summarizeReservoirs(rows, list);
  assert.deepEqual(h.ES030.weekDates, s.weekDates, 'las mismas semanas que el resumen');
  assert.ok(!h.ES030.res.Viejo, 'solo los embalses del último boletín');
  assert.deepEqual(Object.keys(h.ES020.res), []);
  const g = h.ES030.res.Grande;
  for (const k of ['w', 'avg', 'lo', 'hi']) assert.equal(g[k].length, h.ES030.weekDates.length, k);
  const last = g.w[g.w.length - 1];
  // Esta semana en cada año: del más antiguo al anterior, y todos por debajo del actual.
  assert.equal(g.y0 + g.yrs.length, new Date(h.ES030.date).getUTCFullYear());
  assert.ok(g.yrs.every((v) => v < last), 'sube cada año');
  assert.ok(g.lo.every((v, i) => v === null || v <= g.hi[i]));
  assert.ok(Math.abs(g.avg[g.avg.length - 1] - (last - 11)) < 1.5, `media de 10 años ${g.avg[g.avg.length - 1]} frente a ${last}`);
  // Mensual desde el primer mes; récords con fecha.
  assert.equal(g.m0, '2014-01');
  assert.equal(g.since, '2014-01-07');
  assert.ok(g.max[0] >= last - 1e-9 && g.min[0] <= g.yrs[0]);
  assert.match(g.max[1], /^\d{4}-\d{2}-\d{2}$/);
  // Un embalse con pocos datos no tiene media ni banda.
  const n = h.ES030.res.Nuevo;
  assert.equal(n.avg[n.avg.length - 1], null);
  assert.equal(n.lo[n.lo.length - 1], null);
  assert.deepEqual(n.yrs, []);
  // Total de la cuenca, mes a mes.
  assert.equal(h.ES030.total.m0, '2014-01');
  assert.ok(h.ES030.total.m.length > 140);
});

test('presas: cada embalse del inventario está en su cuenca y en España', () => {
  const E = require('../src/shared/embalses');
  const ids = new Set(CUENCAS.basins.map((b) => b.id));
  const keys = Object.keys(E.items);
  assert.ok(keys.length > 350, `${keys.length} embalses`);
  for (const k of keys) {
    const [id, name] = k.split('|');
    const it = E.items[k];
    assert.ok(ids.has(id) && name, k);
    assert.ok(it.lat > 35.8 && it.lat < 43.9 && it.lon > -9.4 && it.lon < 3.4, `${k} fuera de la península`);
    if (it.type) assert.ok(E.types[it.type], `${k}: tipo ${it.type}`);
  }
  const a = E.items['ES030|Alcántara'];
  assert.ok(Math.abs(a.lat - 39.73) < 0.02 && Math.abs(a.lon + 6.886) < 0.02, 'Alcántara, en su presa');
});

const pluvio = () => import(pathToFileURL(path.join(__dirname, '../scripts/agua/pluvio.mjs')).href);

test('pluviómetros: observación horaria, 24 h, temperatura y nombres', async () => {
  const P = await pluvio();
  const H = 3600000;
  const now = Date.UTC(2026, 9, 8, 9, 20);
  const fint = (t) => new Date(t).toISOString().replace('.000Z', '+0000');
  const rows = [];
  // 60 horas: A llueve 1 mm cada hora; B nada; C solo las horas pares.
  for (let h = 0; h < 60; h++) {
    const t = Date.UTC(2026, 9, 8, 9) - h * H;
    rows.push({ idema: 'A', ubi: 'MADRID  RETIRO', lat: 40.41, lon: -3.68, alt: 667, fint: fint(t), prec: 1, ta: 20 - h / 10, hr: 60 });
    rows.push({ idema: 'B', ubi: 'B', lat: 41, lon: -4, fint: fint(t), prec: 0 });
    if (h % 2 === 0) rows.push({ idema: 'C', ubi: 'C', lat: 42, lon: -5, fint: fint(t), prec: 0.5 });
  }
  rows.push({ idema: 'D', ubi: 'D', lat: 42, lon: -5, fint: fint(Date.UTC(2026, 9, 8, 9)) }); // sin prec
  const arch = P.ingestHourly(P.emptyArchive(), rows, now);
  assert.equal(arch.hourly.data.A.prec.length, P.HOURS);
  const out = P.summarize(arch, now);
  assert.equal(out.until, '2026-10-08T09:00:00.000Z');
  const by = Object.fromEntries(out.stations.map((x) => [x[0], x]));
  assert.deepEqual(by.A.slice(1, 6), ['Madrid, Retiro', 40.41, -3.68, 1, 24]);
  assert.equal(by.A[9], 20, 'última temperatura');
  assert.equal(by.B[5], 0);
  assert.equal(by.C[5], null, 'C tiene 12 de 24 horas');
  assert.equal(by.A[6], null, 'sin días climatológicos, 7 días no llegan');
  assert.ok(!by.D, 'sin lluvia medida no se publica');
  // Una hora después: las series se desplazan.
  P.ingestHourly(arch, [{ idema: 'A', ubi: 'MADRID  RETIRO', lat: 40.41, lon: -3.68, fint: fint(Date.UTC(2026, 9, 8, 10)), prec: 3 }], now + H);
  assert.equal(P.summarize(arch, now + H).stations.find((x) => x[0] === 'A')[5], 26);
  const f = P.stationFile(arch, 'A', by.A);
  assert.deepEqual(Object.keys(f.hourly.vars).sort(), ['hr', 'prec', 'ta']);
  assert.equal(f.alt, 667);
  assert.equal(P.gaugeName('LES PLANES D?HOSTOLES'), "Les Planes d'Hostoles");
  assert.equal(P.gaugeName("L'ESTARTIT"), "L'Estartit");
});

test('pluviómetros: días climatológicos (07 a 07) más las horas siguientes', async () => {
  const P = await pluvio();
  const H = 3600000, D = 86400000;
  const now = Date.UTC(2026, 9, 8, 9, 20);
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const daily = [];
  for (let t = Date.UTC(2026, 8, 15); t <= Date.UTC(2026, 9, 4); t += D) daily.push({ fecha: day(t), indicativo: 'A', nombre: 'MADRID', provincia: 'MADRID', altitud: '667', prec: '1,0', tmax: '25,4', tmin: '12,0', dir: '99' });
  daily.push({ fecha: '2026-10-04', indicativo: 'B', prec: 'Acum' });
  const fint = (t) => new Date(t).toISOString().replace('.000Z', '+0000');
  const hourly = [];
  for (let h = 0; h < P.HOURS; h++) hourly.push({ idema: 'A', ubi: 'MADRID', lat: 40.41, lon: -3.68, fint: fint(Date.UTC(2026, 9, 8, 9) - h * H), prec: 0.5 });
  const arch = P.ingestDaily(P.ingestHourly(P.emptyArchive(), hourly, now), daily, now);
  assert.equal(arch.daily.d0, '2026-09-15');
  assert.equal(arch.daily.n, 20);
  assert.equal(arch.daily.data.A.dir, undefined, 'dirección variable: sin dato');
  assert.equal(arch.meta.A.prov, 'Madrid');
  const row = P.summarize(arch, now).stations.find((x) => x[0] === 'A');
  // 7 días desde el 1 oct 07:00: 4 días (1–4 oct) y 74 horas desde el 5 oct 07:00.
  assert.equal(row[6], 4 + 74 * 0.5);
  assert.equal(row[7], null, '30 días: los días guardados empiezan el 15 de septiembre');
  // Con un hueco entre el último día y las horas guardadas (solo 12 horas), los
  // periodos terminan en el último día publicado (5 oct, 07:00 UTC).
  const short = P.ingestDaily(P.ingestHourly(P.emptyArchive(), hourly.slice(0, 12), now), daily, now);
  const s2 = P.summarize(short, now);
  assert.equal(s2.periodsUntil, '2026-10-05T07:00:00.000Z');
  const a2 = s2.stations.find((x) => x[0] === 'A');
  assert.equal(a2[6], 7, '7 días: del 28 sept al 4 oct');
  assert.equal(a2[7], null, '30 días: no hay tantos días');
  assert.equal(a2[8], 4, 'desde el 1 oct: 1–4 oct');
  assert.equal(P.summarize(arch, now).periodsUntil, '2026-10-08T09:00:00.000Z');
  assert.equal(P.dailyNumber('prec', 'Ip'), 0);
  assert.equal(P.dailyNumber('prec', 'Acum'), null);
  assert.equal(P.dailyNumber('dir', '27'), 270);
});

test('pluviómetros: qué tramos diarios pedir', async () => {
  const P = await pluvio();
  const H = 3600000;
  const now = Date.UTC(2026, 9, 8, 9, 20);
  const arch = P.emptyArchive();
  const plan = P.planDaily(arch, now, { maxBack: 2 });
  assert.deepEqual(plan.map((c) => [c.kind, c.from, c.to]), [
    ['latest', '2026-09-24', '2026-10-08'],
    ['back', '2026-09-09', '2026-09-23'],
    ['back', '2026-08-25', '2026-09-08']
  ]);
  for (const c of plan) P.markFetched(arch, c, now);
  const next = P.planDaily(arch, now + H, { maxBack: 1 });
  assert.deepEqual(next.map((c) => [c.kind, c.from]), [['back', '2026-08-10']], 'los últimos días no se repiten antes de 3 horas');
  arch.fetched.oldest = '2024-10-07';
  assert.deepEqual(P.planDaily(arch, now + H), [], 'dos años completos');
});

test('el script de datos importa todo lo que usa de lib.mjs', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../scripts/agua/datos.mjs'), 'utf8');
  const imported = /import \{([^}]+)\} from '\.\/lib\.mjs'/.exec(src)[1].split(',').map((x) => x.trim());
  for (const name of Object.keys(await lib())) {
    if (new RegExp(`\\b${name}\\(`).test(src) || new RegExp(`\\b${name}\\.`).test(src)) assert.ok(imported.includes(name), `falta importar ${name}`);
  }
});
