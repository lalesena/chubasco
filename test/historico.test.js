// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const hist = () => import(pathToFileURL(path.join(__dirname, '../scripts/agua/historico.mjs')).href);
const pluvio = () => import(pathToFileURL(path.join(__dirname, '../scripts/agua/pluvio.mjs')).href);
const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/aemet', name), 'utf8'));

const DAY = 86400000;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const comma = (v) => String(v).replace('.', ',');

/** Un historial listo para usar con las estaciones indicadas como «publicadas». */
function setup(H, P, ids, edge) {
  const h = H.emptyHistory();
  h.edge = h.cursor = edge;
  const arch = P.emptyArchive();
  for (const id of ids) arch.meta[id] = { lat: 40, lon: -3, name: id };
  return { h, arch };
}

/** Suma las filas de la API directamente (el camino de ingestChunk, sin cursor). */
function direct(H, rows, id) {
  const st = {};
  for (const r of rows) {
    if (r.indicativo !== id) continue;
    const v = H.rowValues(r);
    if (Object.values(v).every((x) => x === null)) continue;
    const t = new Date(Date.parse(r.fecha + 'T00:00:00Z'));
    H.addDay(st, t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), v);
  }
  return st;
}

// ---------------------------------------------------------------------------

test('histórico: un mes con Ip, Acum, huecos, medias y extremos', async () => {
  const H = await hist();
  // Febrero de 2020 (29 días), 20 días medidos.
  const rows = [];
  for (let d = 1; d <= 20; d++) {
    const prec = { 1: '1,0', 2: 'Ip', 3: 'Acum', 4: '12,3', 6: '0,5', 7: '12,3' }[d] ?? '0,0';
    rows.push({
      indicativo: 'A', fecha: `2020-02-${String(d).padStart(2, '0')}`, prec,
      tmed: comma(d.toFixed(1)), tmax: comma((d + 5).toFixed(1)), tmin: comma((d - 5).toFixed(1)),
      hrMedia: '60', velmedia: d <= 10 ? '2,0' : '4,0', racha: d === 9 ? '13,5' : '8,0', sol: d <= 5 ? '8,0' : undefined
    });
  }
  const st = direct(H, rows, 'A');
  assert.equal(st.m0, '2020-02');
  assert.equal(st.pN[0], 19, 'Acum no cuenta como día medido');
  assert.equal(st.pS[0], 261, '1,0 + Ip(0) + 12,3 + 0,5 + 12,3 = 26,1 mm');
  assert.equal(st.pR[0], 4, 'días ≥ 0,1 mm: Ip no cuenta');
  assert.equal(st.pR1[0], 3, 'días ≥ 1 mm');
  assert.deepEqual([st.pX[0], st.pXd[0]], [123, 4], 'empate de máximos: el día más temprano');
  assert.deepEqual(direct(H, rows.slice().reverse(), 'A'), st, 'el orden de llegada de los días no cambia nada (empates incluidos)');
  const s = H.monthlySeries(st, true);
  assert.deepEqual([s.m0, s.complete], ['2020-02', true]);
  assert.deepEqual(
    [s.prec[0], s.rainDays[0], s.rainDays1[0], s.precMax[0], s.cov[0]],
    [26.1, 4, 3, 12.3, 66], '19 de 29 días');
  assert.deepEqual([s.tmean[0], s.tmax[0], s.tmin[0]], [10.5, 15.5, 5.5]);
  assert.deepEqual([s.tmaxAbs[0], s.tminAbs[0]], [25, -4]);
  assert.deepEqual([s.hr[0], s.wind[0], s.gust[0]], [60, 3, 13.5]);
  assert.equal(s.sun, undefined, '5 días de sol de 29: sin media');
  // Con solo 10 días la media no sale, pero el total y los extremos sí.
  const few = direct(H, rows.slice(0, 10), 'A');
  const f = H.monthlySeries(few, false);
  assert.equal(f.tmean, undefined);
  assert.equal(f.prec[0], 26.1);
  assert.equal(f.tmaxAbs[0], 15);
  assert.equal(f.complete, false);
});

test('histórico: valores imposibles se ignoran y los sumandos son exactos', async () => {
  const H = await hist();
  const st = {};
  H.addDay(st, 2021, 0, 1, { prec: 0.1, tmed: 0.1, tmax: 99, tmin: -99, hr: 150, vel: 200, racha: -1, sol: 30 });
  H.addDay(st, 2021, 0, 2, { prec: 0.2, tmed: 0.2 });
  H.addDay(st, 2021, 0, 3, { prec: 0.7, tmed: 0.7 });
  assert.equal(st.pS[0], 10, '0,1 + 0,2 + 0,7 = 1,0 sin error de coma flotante (décimas enteras)');
  assert.equal(st.tS[0], 10);
  assert.deepEqual([st.xN[0], st.nN[0], st.hN[0], st.wN[0], st.sN[0], st.gAd[0]], [0, 0, 0, 0, 0, 0]);
});

test('histórico: tramo real de 1990 (3 estaciones, 15 días) frente a un cálculo independiente', async () => {
  const H = await hist(), P = await pluvio();
  const rows = fx('diarios-1990-01-01_15.json');
  const ids = [...new Set(rows.map((r) => r.indicativo))];
  assert.equal(ids.length, 3);
  const { h, arch } = setup(H, P, ids, '1990-01-16');
  assert.deepEqual(H.nextChunk(h), { from: '1990-01-01', to: '1990-01-15' });
  const res = H.ingestChunk(h, arch, H.nextChunk(h), rows);
  assert.equal(res.advanced, true);
  assert.equal(res.ingested, 45);
  assert.equal(h.cursor, '1990-01-01');
  const n = (x) => (x === undefined || x === 'Acum' ? null : x === 'Ip' ? 0 : Number(String(x).replace(',', '.')));
  for (const id of ids) {
    const mine = rows.filter((r) => r.indicativo === id);
    const prec = mine.map((r) => n(r.prec)).filter((x) => x !== null);
    const st = h.stations[id];
    assert.equal(st.pN[0], prec.length, id);
    assert.equal(st.pS[0], Math.round(prec.reduce((a, b) => a + b, 0) * 10), id);
    assert.equal(st.pR[0], prec.filter((x) => x >= 0.1).length, id);
    assert.equal(st.pR1[0], prec.filter((x) => x >= 1).length, id);
    assert.equal(st.pX[0], Math.round(Math.max(...prec) * 10), id);
    const tx = mine.map((r) => n(r.tmax)).filter((x) => x !== null);
    assert.equal(st.xS[0], Math.round(tx.reduce((a, b) => a + b, 0) * 10), id);
    assert.equal(st.xA[0], Math.round(Math.max(...tx) * 10), id);
    const ve = mine.map((r) => n(r.velmedia)).filter((x) => x !== null);
    assert.equal(st.wS[0], Math.round(ve.reduce((a, b) => a + b, 0) * 10), id);
  }
  assert.ok(Object.values(h.stations).some((s) => s.pR[0] < s.pN[0]), 'hay días de Ip o secos');
});

test('histórico: Retiro en enero de 1920, tres tramos al revés dan lo mismo que de una vez', async () => {
  const H = await hist(), P = await pluvio();
  const rows = fx('diarios-3195-1920-01.json');
  assert.equal(rows.length, 31);
  const whole = direct(H, rows, '3195');
  const { h, arch } = setup(H, P, ['3195'], '1920-02-01');
  const chunks = [];
  for (let c; (c = H.nextChunk(h)) && chunks.length < 3;) { chunks.push(c); H.ingestChunk(h, arch, c, rows); }
  assert.deepEqual(chunks.map((c) => [c.from, c.to]), [['1920-01-17', '1920-01-31'], ['1920-01-02', '1920-01-16'], ['1919-12-18', '1920-01-01']]);
  assert.deepEqual(h.stations['3195'], whole, 'cada día una sola vez, sin importar el orden');
  const s = H.monthlySeries(whole, true);
  assert.equal(s.m0, '1920-01');
  const total = rows.map((r) => (r.prec === 'Ip' ? 0 : Number(String(r.prec ?? 0).replace(',', '.')))).reduce((a, b) => a + b, 0);
  assert.equal(s.prec[0], Math.round(total * 10) / 10);
  assert.equal(s.prec[0], 2.8);
  assert.equal(s.cov[0], 100);
  assert.equal(s.wind, undefined, 'en 1920 no hay viento');
  assert.ok(s.sun[0] > 3 && s.sun[0] < 6);
  // Un tramo repetido por error no puede contar dos veces los días de fuera de su rango.
  const again = H.ingestChunk(h, arch, { from: '1920-01-17', to: '1920-01-31' }, rows);
  assert.equal(again.ingested, 15);
});

// ---------------------------------------------------------------------------
// Un mundo simulado: avance del borde + relleno hacia atrás, a lo largo de meses

function world(startOf) {
  // Valores de un día de una estación (texto, como los da la API) o undefined si no hay.
  const val = (id, t) => {
    const start = startOf[id];
    if (start === undefined || dayKey(t) < start) return undefined;
    const k = Math.round(t / DAY) % 9973 + id.charCodeAt(0);
    const row = { fecha: dayKey(t), indicativo: id, nombre: id, provincia: 'X', altitud: '10' };
    const m = k % 13;
    if (m === 0) row.prec = 'Ip'; else if (m === 1) row.prec = 'Acum'; else if (m !== 2) row.prec = comma(((k * 7) % 53) / 10);
    if (k % 17) { row.tmed = comma((((k * 3) % 300) / 10 - 5).toFixed(1)); row.tmax = comma((((k * 3) % 300) / 10 + 1).toFixed(1)); row.tmin = comma((((k * 3) % 300) / 10 - 11).toFixed(1)); }
    if (k % 5) row.hrMedia = String(40 + (k % 55));
    if (k % 3) { row.velmedia = comma(((k % 60) / 10).toFixed(1)); row.racha = comma(((k % 200) / 10 + 3).toFixed(1)); }
    if (k % 4 === 0) row.sol = comma(((k % 120) / 10).toFixed(1));
    return row;
  };
  // Lo que devuelve la API para un tramo: todas las estaciones (también las que no publicamos).
  const api = (from, to, today) => {
    const rows = [];
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z') && dayKey(t) <= today; t += DAY) for (const id of Object.keys(startOf)) { const r = val(id, t); if (r) rows.push(r); }
    return rows;
  };
  return { val, api };
}

test('histórico: relleno hacia atrás y avance del borde durante cuatro meses, sin huecos ni días repetidos', async () => {
  const H = await hist(), P = await pluvio();
  const first = dayKey(Date.UTC(2022, 0, 1));
  const W = world({ A: first, B: '2023-06-15', C: first }); // C no se publica
  const ids = ['A', 'B'];
  const base = Date.UTC(2026, 9, 8, 9, 20);
  const arch = P.emptyArchive();
  for (const id of ids) arch.meta[id] = { lat: 40, lon: -3, name: id };
  const h = H.emptyHistory();
  h.floor = first; // para que acabe pronto (en producción, 1900)
  const edges = new Set();
  let compared = 0, wasDone = null;
  for (let k = 0; k < 120; k++) {
    const now = base + k * DAY;
    const today = dayKey(now);
    H.rollForward(h, arch, now);
    edges.add(h.edge);
    for (const chunk of P.planDaily(arch, now, { maxBack: 6 })) {
      P.ingestDaily(arch, W.api(chunk.from, chunk.to, today), now);
      P.markFetched(arch, chunk, now);
    }
    for (let n = 0, c; n < 24 && (c = H.nextChunk(h)); n++) {
      assert.ok(c.to < h.edge, 'el relleno no pasa del borde');
      H.ingestChunk(h, arch, c, W.api(c.from, c.to, today));
    }
    if (wasDone === null && h.done) wasDone = k;
    assert.ok(h.edge >= dayKey(H.windowStart(now)), 'el borde nunca queda detrás del inicio de la ventana diaria');
    // La verdad: todos los días del mundo hasta hoy, sumados de golpe.
    if (arch.fetched.oldest <= h.edge) {
      for (const id of ids) {
        const rows = W.api(first, today, today);
        const truth = H.combined({ stations: { [id]: direct(H, rows, id) }, edge: '9999-01-01', cursor: null, done: true }, { daily: null }, id);
        const mine = H.combined(h, arch, id);
        if (h.done) assert.deepEqual(mine, truth, `${id} el ${today}`);
        else {
          // Mientras el relleno sigue, solo faltan los meses más antiguos: lo que sale coincide con la verdad.
          const idx = (m0) => Number(m0.slice(0, 4)) * 12 + Number(m0.slice(5, 7)) - 1;
          const skip = idx(mine.m0) - idx(truth.m0);
          assert.ok(skip >= 0);
          for (const key of H.ACC) assert.deepEqual(mine[key], truth[key].slice(skip), `${id} ${key} el ${today}`);
        }
        compared++;
      }
    }
  }
  assert.ok(wasDone !== null && wasDone < 60, `relleno terminado a los ${wasDone} días`);
  assert.ok(compared > 100);
  assert.ok(edges.size >= 4, `el borde avanzó: ${[...edges].join(' ')}`);
  assert.ok(h.stations.C === undefined, 'las estaciones que no publicamos no entran');
  // B empieza en junio de 2023: su primer mes es parcial en el almacén y completo en la serie.
  const sb = H.monthlySeries(H.combined(h, arch, 'B'), true);
  assert.equal(sb.m0, '2023-06');
  assert.equal(sb.cov[0] <= 55 && sb.cov[0] >= 40, true, `junio de 2023 solo desde el día 15: ${sb.cov[0]} %`);
});

test('histórico: tras una parada larga el borde salta de golpe y no se pierde ni se repite ningún día anterior', async () => {
  const H = await hist(), P = await pluvio();
  const first = '2022-01-01';
  const W = world({ A: first });
  const base = Date.UTC(2026, 9, 8, 9, 20);
  const run = (h, arch, now) => {
    const today = dayKey(now);
    const r = H.rollForward(h, arch, now);
    for (const chunk of P.planDaily(arch, now, { maxBack: 60 })) { P.ingestDaily(arch, W.api(chunk.from, chunk.to, today), now); P.markFetched(arch, chunk, now); }
    for (let n = 0, c; n < 200 && (c = H.nextChunk(h)); n++) H.ingestChunk(h, arch, c, W.api(c.from, c.to, today));
    return r;
  };
  for (const gap of [10, 70]) {
    const arch = P.emptyArchive(), h = H.emptyHistory();
    arch.meta.A = { lat: 40, lon: -3 };
    h.floor = first;
    run(h, arch, base);
    run(h, arch, base + DAY);
    const r = run(h, arch, base + gap * DAY);
    const today = dayKey(base + gap * DAY);
    const truth = H.combined({ stations: { A: direct(H, W.api(first, today, today), 'A') }, edge: '9999-01-01', cursor: null, done: true }, { daily: null }, 'A');
    const mine = H.combined(h, arch, 'A');
    assert.ok(!r.lost, JSON.stringify(r));
    assert.equal(h.edge, H.edgeFor(base + gap * DAY));
    if (gap === 10) assert.deepEqual(mine, truth, 'con 10 días de parada el último tramo de 15 días lo cubre todo');
    else {
      // Los días de la parada que el tramo «últimos 15 días» no alcanza no existen (límite del archivo diario);
      // todo lo anterior al borde, que salió del archivo viejo, está entero.
      assert.equal(h.edge, '2025-02-01', 'dos meses de golpe');
      const n = 37; // 2022-01 … 2025-01
      for (const key of H.ACC) assert.deepEqual(mine[key].slice(0, n), truth[key].slice(0, n), key);
    }
  }
});

test('histórico: el borde espera a que el archivo diario tenga descargados esos días', async () => {
  const H = await hist(), P = await pluvio();
  const now = Date.UTC(2026, 11, 5, 9, 20);
  const { h, arch } = setup(H, P, ['A'], '2024-12-01');
  assert.deepEqual(H.rollForward(h, arch, now), { waiting: true, days: 0 }, 'sin archivo diario');
  arch.daily = { d0: '2024-11-05', n: 3, data: { A: { prec: [1, 2, 3] } } };
  arch.fetched = { oldest: '2024-12-02' };
  assert.equal(H.rollForward(h, arch, now).waiting, true, 'el tramo más antiguo pedido empieza después del borde');
  assert.equal(h.edge, '2024-12-01');
  arch.fetched.oldest = '2024-11-05';
  assert.equal(H.rollForward(h, arch, now).waiting, undefined);
  assert.equal(h.edge, H.edgeFor(now));
});

// ---------------------------------------------------------------------------

test('histórico: cursor, suelo y fin tras un año seguido sin datos antes de 1920', async () => {
  const H = await hist(), P = await pluvio();
  // Cursor y borde iniciales.
  const now = Date.UTC(2026, 9, 8, 9, 20);
  assert.equal(H.edgeFor(now), '2024-12-01', 'inicio de la ventana (7-oct-2024) + 31 días, al día 1 siguiente');
  const a = setup(H, P, ['A'], H.edgeFor(now));
  assert.deepEqual(H.nextChunk(a.h), { from: '2024-11-16', to: '2024-11-30' });
  assert.deepEqual(H.rollForward(H.emptyHistory(), a.arch, now), { init: true, days: 0 });
  // El suelo recorta el último tramo y termina.
  const b = setup(H, P, ['A'], '2024-12-01');
  b.h.floor = '2024-11-20';
  const c = H.nextChunk(b.h);
  assert.deepEqual(c, { from: '2024-11-20', to: '2024-11-30' });
  H.ingestChunk(b.h, b.arch, c, [{ indicativo: 'A', fecha: '2024-11-25', prec: '1,0' }]);
  assert.equal(b.h.done, true);
  assert.equal(H.nextChunk(b.h), null);
  // Sin suelo propio: el de 1900.
  const d = setup(H, P, ['A'], '1900-01-10');
  assert.deepEqual(H.nextChunk(d.h), { from: '1900-01-01', to: '1900-01-09' });
  // Un año seguido de tramos sin datos (de nuestras estaciones) antes de 1920 → fin.
  const e = setup(H, P, ['A'], '1920-01-01');
  const other = (c2) => [{ indicativo: 'X', fecha: c2.to, prec: '1,0' }]; // solo una estación que no publicamos
  let n = 0;
  for (let ch; (ch = H.nextChunk(e.h)); n++) {
    if (n === 10) H.ingestChunk(e.h, e.arch, ch, [{ indicativo: 'A', fecha: ch.to, prec: '2,0' }]); // un dato: la cuenta empieza de nuevo
    else H.ingestChunk(e.h, e.arch, ch, other(ch));
  }
  assert.equal(n, 36, '11 tramos hasta el dato + 25 vacíos (375 días ≥ 365)');
  assert.equal(e.h.done, true);
  assert.ok(e.h.empty >= 365 && e.h.empty < 365 + 15);
  assert.ok(e.h.cursor < '1919-01-01' && e.h.cursor > '1918-01-01');
  assert.ok(e.h.stations.A.pS[0] === 20 && e.h.stations.A.m0 === '1919-08', 'el dato suelto queda');
  // Un tramo vacío por completo después de 1920 se repite dos veces antes de darlo por vacío.
  const f = setup(H, P, ['A'], '1950-03-01');
  const ch = H.nextChunk(f.h);
  assert.equal(H.ingestChunk(f.h, f.arch, ch, []).advanced, false);
  assert.equal(f.h.cursor, '1950-03-01');
  assert.equal(H.ingestChunk(f.h, f.arch, ch, []).advanced, false);
  assert.equal(H.ingestChunk(f.h, f.arch, ch, []).advanced, true);
  assert.equal(f.h.cursor, ch.from);
  assert.equal(f.h.empty, 0, 'después de 1920 un tramo vacío no cuenta para el fin');
  // Con filas solo de otras estaciones, en cambio, avanza a la primera.
  assert.equal(H.ingestChunk(f.h, f.arch, H.nextChunk(f.h), other({ to: '1950-02-10' })).advanced, true);
});

// ---------------------------------------------------------------------------

test('normales: Retiro 1991-2020, unidades y huecos', async () => {
  const H = await hist();
  const rows = fx('normales-3195.json');
  assert.equal(rows.length, 13);
  const n = H.parseNormals(rows);
  assert.equal(n.period, '1991-2020');
  assert.equal(n.n, 30);
  assert.deepEqual(n.months.prec.slice(0, 3), [32, 33.5, 35.3]);
  assert.equal(n.year.prec, 416.8);
  assert.ok(Math.abs(n.months.prec.reduce((a, b) => a + b, 0) - n.year.prec) < 0.2, 'los meses suman el año');
  assert.deepEqual(n.months.precQ.map((q) => q[0]), [12.9, 18.6, 28.4, 51.8], 'quintiles de enero');
  assert.deepEqual(n.year.precQ, [334.8, 381.4, 465.9, 501.1]);
  assert.ok(n.months.precQ.every((q) => q.every((x, i) => i === 0 || x >= q[i - 1])) || true);
  for (let m = 0; m < 12; m++) {
    const q = n.months.precQ.map((a) => a[m]);
    assert.ok(q.every((x, i) => i === 0 || x >= q[i - 1]), `quintiles crecientes en el mes ${m + 1}`);
  }
  assert.equal(n.months.precHi[9], 192.4);
  assert.equal(n.months.rainDays[0], 8.5, 'días ≥ 0,1 mm (np_001)');
  assert.equal(n.months.rainDays1[0], 5.5, 'días ≥ 1 mm');
  assert.deepEqual([n.months.precMax[0], n.year.precMaxHi], [9.9, 50.2]);
  assert.deepEqual([n.months.tmean[0], n.months.tmax[0], n.months.tmin[0]], [6.5, 10, 3]);
  assert.deepEqual([n.year.tmaxHi, n.year.tminLo], [40.7, -6.1]);
  assert.equal(n.year.hr, 58);
  // El viento medio llega en km/h (6,5 km/h) y sale en m/s; las rachas ya vienen en m/s.
  assert.equal(n.months.wind[0], 1.8);
  assert.deepEqual([n.months.gust[0], n.months.gustHi[6]], [17.3, 28.1]);
  // Sin dato ('' y '-'): fuera. Retiro solo tiene insolación en marzo.
  assert.deepEqual(n.months.sun.map((x) => x !== null), [false, false, true, false, false, false, false, false, false, false, false, false]);
  assert.equal(n.year.sun, undefined);
  assert.equal(n.year.frostDays, 12.7);
  assert.equal(n.months.hotDays[6], 24.6);
  assert.equal(n.months.evap, undefined, 'lo que no se usa, fuera');
  assert.ok(JSON.stringify(n).length < 4000, `${JSON.stringify(n).length} bytes`);
  // Sin filas, o sin lluvia ni temperatura: no hay normales.
  assert.equal(H.parseNormals([]), null);
  assert.equal(H.parseNormals([{ mes: '01', hr_md: '70' }, { mes: '13', hr_md: '70' }]), null);
});

test('normales y récords: qué se pide, cuándo se repite y qué pasa si falla', async () => {
  const H = await hist();
  const h = H.emptyHistory();
  const rows = fx('normales-3195.json');
  assert.deepEqual(H.due(h, 'normals', ['B', 'A', 'C'], '2026-10-08', 2), ['A', 'B']);
  H.setNormals(h, 'A', rows, '2026-10-08');
  H.setNormals(h, 'B', [], '2026-10-08'); // la API no tiene normales de B
  assert.equal(h.normals.A.next, '2027-04-06', '180 días');
  assert.deepEqual(h.normals.B, { v: null, next: '2026-11-07' }, 'sin normales: se reintenta en 30 días');
  assert.deepEqual(H.due(h, 'normals', ['A', 'B', 'C'], '2026-10-09', 5), ['C']);
  assert.deepEqual(H.due(h, 'normals', ['A', 'B', 'C'], '2026-11-07', 5), ['C', 'B']);
  H.failItem(h, 'normals', 'C', '2026-10-09');
  assert.deepEqual(h.normals.C, { v: null, next: '2026-10-10', fails: 1 }, 'un fallo se reintenta mañana');
  H.failItem(h, 'normals', 'C', '2026-10-10');
  H.failItem(h, 'normals', 'C', '2026-10-12');
  assert.deepEqual(h.normals.C, { v: null, next: '2026-10-16', fails: 3 }, 'cada fallo espera el doble: 1, 2, 4 días');
  H.failItem(h, 'normals', 'A', '2027-04-06');
  assert.equal(h.normals.A.v.period, '1991-2020', 'un fallo no borra lo que ya había');
  H.setNormals(h, 'C', rows, '2026-10-16');
  assert.equal(h.normals.C.fails, undefined, 'y un acierto lo olvida');
  // Récords: 90 días.
  H.setRecords(h, 'A', { P: fx('extremos-P-3195.json'), T: fx('extremos-T-3195.json'), V: fx('extremos-V-3195.json') }, '2026-10-08');
  assert.equal(h.records.A.next, '2027-01-06');
  H.setRecords(h, 'B', { P: [], T: [] }, '2026-10-08');
  assert.deepEqual(h.records.B, { v: null, next: '2026-11-07' });
});

test('récords: Retiro (P, T y V de AEMET), fechas y unidades', async () => {
  const H = await hist();
  const rec = H.parseRecords({ P: fx('extremos-P-3195.json'), T: fx('extremos-T-3195.json'), V: fx('extremos-V-3195.json') });
  assert.equal(rec.source, 'aemet');
  // Lluvia: AEMET da décimas de mm.
  assert.deepEqual(rec.all.precDay, [87, '1972-09-21']);
  assert.deepEqual(rec.month.precDay[0], [36.2, '1979-01-18']);
  assert.deepEqual(rec.all.precHi, [235.4, '2025-03'], 'marzo de 2025: lo mismo que suman los datos diarios de ese mes');
  assert.deepEqual(rec.all.precLo, [0, '2017-09']);
  assert.deepEqual(rec.month.precLo[1], [0, '2020-02'], '«IP» (inapreciable) = 0');
  assert.deepEqual(rec.all.rainDays, [28, '1946-04']);
  assert.deepEqual(rec.all.snowDays, [8, '1941-01']);
  assert.equal(rec.month.snowDays[4], null, 'mayo: 0 días de nieve = sin récord');
  assert.deepEqual(rec.all.stormDays, [11, '1998-05']);
  // Temperaturas: décimas de °C.
  assert.deepEqual(rec.all.tmaxHi, [40.7, '2021-08-14']);
  assert.deepEqual(rec.all.tminLo, [-10.1, '1945-01-16']);
  assert.deepEqual(rec.month.tmaxHi[11], [18.6, '1979-12-01']);
  assert.deepEqual(rec.all.tmeanHi, [29.8, '2015-07']);
  assert.deepEqual(rec.all.tmeanLo, [1.9, '1956-02']);
  assert.deepEqual(rec.all.tmaxMeanHi, [36.8, '2022-07']);
  assert.deepEqual(rec.all.tminMeanLo, [-2.6, '1956-02']);
  // Racha: AEMET la da en km/h (116 km/h, mayo no; marzo de 1951) y sale en m/s.
  assert.deepEqual(rec.all.gustHi, [32.2, '1951-03-13']);
  assert.deepEqual(rec.month.gustHi[0], [26.9, '1965-01-20']);
  // Coherencia con las normales 1991-2020 de la misma estación: un récord no es menor que el máximo de un periodo.
  const n = H.parseNormals(fx('normales-3195.json'));
  assert.ok(rec.all.precDay[0] >= n.year.precMaxHi);
  assert.ok(rec.all.precHi[0] >= n.months.precHi.reduce((a, b) => Math.max(a, b)));
  assert.ok(rec.all.tmaxHi[0] >= n.year.tmaxHi && rec.all.tminLo[0] <= n.year.tminLo);
  assert.ok(rec.all.gustHi[0] >= n.months.gustHi.reduce((a, b) => Math.max(a, b)) && rec.all.gustHi[0] < 1.6 * Math.max(...n.months.gustHi), 'unidades de las rachas');
  // Canarias: ceros en nieve → sin récord; faltan T y V → solo lo que hay.
  const c = H.parseRecords({ P: fx('extremos-P-C018J.json') });
  assert.equal(c.all.snowDays, undefined);
  assert.deepEqual(c.all.precDay, [92.8, '1991-12-04']);
  assert.equal(c.all.tmaxHi, undefined);
  // Sin nada (la API responde 404 → []).
  assert.equal(H.parseRecords({ P: [], T: [], V: undefined }), null);
});

test('récords calculados: solo con meses casi completos y cuando el relleno ha terminado', async () => {
  const H = await hist(), P = await pluvio();
  const { h, arch } = setup(H, P, ['A'], '2030-01-01');
  const st = {};
  // 2021: enero completo (31 días) y febrero con 20 días.
  for (let d = 1; d <= 31; d++) H.addDay(st, 2021, 0, d, { prec: d === 10 ? 40 : 1, tmed: 5, tmax: d === 20 ? 22.5 : 10, tmin: d === 3 ? -9 : 0, racha: d === 5 ? 30 : 10 });
  for (let d = 1; d <= 20; d++) H.addDay(st, 2021, 1, d, { prec: 100, tmed: 30, tmax: 40, tmin: 20, racha: 11 });
  H.addDay(st, 2022, 0, 15, { prec: 80, tmed: 5, tmax: 12, tmin: -12 });
  h.stations.A = st;
  h.edge = '2030-01-01'; h.cursor = '2021-01-01';
  assert.equal(H.stationExtras(h, arch, 'A').records, undefined, 'mientras se rellena, no se calcula nada');
  h.done = true;
  const r = H.stationExtras(h, arch, 'A').records;
  assert.equal(r.source, 'calculado');
  assert.equal(r.from, '2021-01');
  assert.deepEqual(r.all.precDay, [100, '2021-02-01'], 'récords de un día: cualquier mes, el primero entre empatados');
  assert.deepEqual(r.all.tmaxHi, [40, '2021-02-01']);
  assert.deepEqual(r.all.tminLo, [-12, '2022-01-15']);
  assert.deepEqual(r.all.gustHi, [30, '2021-01-05']);
  assert.deepEqual(r.all.precHi, [31 * 1 + 39, '2021-01'], 'febrero (20 de 28 días) no cuenta para los totales; enero de 2022 (1 día) tampoco');
  assert.equal(r.all.precLo[1], '2021-01');
  assert.equal(r.month.tmeanHi[1], null, 'febrero no tiene un mes completo');
  assert.deepEqual(r.month.precDay[0], [80, '2022-01-15']);
  assert.deepEqual(r.all.rainDays, [31, '2021-01']);
  // Si AEMET da los suyos, esos mandan.
  h.records.A = { v: H.parseRecords({ P: fx('extremos-P-3195.json') }), next: '2027-01-01' };
  assert.equal(H.stationExtras(h, arch, 'A').records.source, 'aemet');
});

// ---------------------------------------------------------------------------

test('ficha de estación: history, normals y records se añaden sin tocar lo que ya había', async () => {
  const H = await hist(), P = await pluvio();
  const now = Date.UTC(2026, 9, 8, 9, 20);
  const fint = (t) => new Date(t).toISOString().replace('.000Z', '+0000');
  const rows = [];
  for (let h = 0; h < 30; h++) rows.push({ idema: 'A', ubi: 'MADRID  RETIRO', lat: 40.41, lon: -3.68, alt: 667, fint: fint(Date.UTC(2026, 9, 8, 9) - h * 3600000), prec: 0.2, ta: 15 });
  const arch = P.ingestHourly(P.emptyArchive(), rows, now);
  const daily = [];
  for (let t = Date.UTC(2026, 8, 20); t <= Date.UTC(2026, 9, 6); t += DAY) daily.push({ fecha: dayKey(t), indicativo: 'A', nombre: 'MADRID', provincia: 'MADRID', altitud: '667', prec: '1,5', tmed: '14,0', tmax: '20,0', tmin: '8,0', hrMedia: '70' });
  P.ingestDaily(arch, daily, now);
  const h = H.emptyHistory();
  H.rollForward(h, arch, now);
  // Un año antiguo ya rellenado: 2019, enero a diciembre, todos los días.
  const st = {};
  for (let m = 0; m < 12; m++) for (let d = 1; d <= 28; d++) H.addDay(st, 2019, m, d, { prec: m === 6 ? 0 : 1, tmed: 10 + m, tmax: 15 + m, tmin: 5 + m, hr: 60 });
  h.stations.A = st;
  h.cursor = '2019-01-01';
  H.setNormals(h, 'A', fx('normales-3195.json'), '2026-10-08');
  const row = P.summarize(arch, now).stations.find((x) => x[0] === 'A');
  const base = P.stationFile(arch, 'A', row);
  const extra = H.stationExtras(h, arch, 'A');
  assert.deepEqual(Object.keys(extra).sort(), ['history', 'normals'], 'récords solo cuando AEMET los da o el relleno acabó');
  for (const k of Object.keys(extra)) assert.equal(base[k], undefined, `${k} no pisa nada`);
  const hs = extra.history;
  assert.equal(hs.m0, '2019-01');
  assert.equal(hs.complete, false);
  assert.equal(hs.prec.length, 94, 'enero de 2019 a octubre de 2026, un valor por mes (los meses sin datos, null)');
  assert.ok(Object.entries(hs).filter(([, v]) => Array.isArray(v)).every(([, v]) => v.length === hs.prec.length));
  assert.equal(hs.prec[0], 28);
  assert.equal(hs.prec[6], 0);
  assert.equal(hs.tmean[11], 21);
  assert.equal(hs.hr[3], 60);
  assert.equal(hs.prec[12], null, 'enero de 2020: sin datos');
  assert.equal(hs.wind, undefined, 'sin viento, sin columna');
  assert.equal(hs.gust, undefined);
  // Los meses desde el borde (1-dic-2024) salen del archivo diario: septiembre (11 días medidos) y octubre (6) de 2026.
  assert.equal(h.edge, '2024-12-01');
  assert.deepEqual(hs.prec.slice(-2), [16.5, 9]);
  assert.deepEqual(hs.cov.slice(-2), [37, 19], 'el mes en curso sale incompleto, y se dice cuánto');
  assert.equal(hs.tmean[hs.tmean.length - 2], null, 'media de 11 de 30 días: sin media');
  assert.equal(hs.tmaxAbs[hs.tmean.length - 2], 20);
  JSON.parse(JSON.stringify({ ...base, ...extra }));
});

test('ficha: lo que el relleno aún no ha cubierto (el mes del cursor) no se publica a medias', async () => {
  const H = await hist(), P = await pluvio();
  const { h, arch } = setup(H, P, ['A'], '2024-12-01');
  const rows = [];
  for (let t = Date.UTC(2024, 10, 1); t < Date.UTC(2024, 11, 1); t += DAY) rows.push({ indicativo: 'A', fecha: dayKey(t), prec: '2,0' });
  h.cursor = '2024-11-17'; // solo se ha rellenado la segunda mitad de noviembre
  const half = rows.filter((r) => r.fecha >= '2024-11-17');
  for (const r of half) H.addDay((h.stations.A ||= {}), 2024, 10, +r.fecha.slice(8), H.rowValues(r));
  assert.equal(H.combined(h, arch, 'A'), null, 'noviembre empezó antes del cursor: sin meses completos');
  h.cursor = '2024-11-01';
  for (const r of rows.filter((x) => x.fecha < '2024-11-17')) H.addDay(h.stations.A, 2024, 10, +r.fecha.slice(8), H.rowValues(r));
  assert.equal(H.monthlySeries(H.combined(h, arch, 'A'), false).prec[0], 60);
});

test('tamaño: un archivo realista cabe (estaciones por década según AEMET)', async () => {
  const H = await hist();
  // 1920: 13 · 1950: 62 · 1970: 100 · 1990: 164 · 2005: 336 · 2015: 814 estaciones por tramo.
  const nAt = (y) => { const pts = [[1920, 13], [1950, 62], [1970, 100], [1990, 164], [2005, 336], [2015, 814], [2026, 830]]; for (let i = 1; i < pts.length; i++) if (y <= pts[i][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (y - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); return 830; };
  let months = 0;
  for (let y = 1920; y <= 2026; y++) months += Math.round(nAt(y)) * 12;
  assert.ok(months > 250000 && months < 330000, `${months} meses de estación`);
  // Una estación desde 1920 (la peor): su serie publicada tiene que caber en unos pocos KB por variable.
  const st = {};
  for (let y = 1920; y <= 2025; y++) for (let m = 0; m < 12; m++) for (let d = 1; d <= 28; d++) H.addDay(st, y, m, d, { prec: 1.2, tmed: 12.3, tmax: 18.1, tmin: 6.4, hr: 61, vel: 2.1, racha: 14.3, sol: 6.4 });
  const s = H.monthlySeries(st, true);
  assert.equal(s.prec.length, 106 * 12);
  assert.ok(JSON.stringify(s).length < 90000, `${JSON.stringify(s).length} bytes`);
});

// ---------------------------------------------------------------------------

test('histórico: no encoge, salvo reset', async () => {
  const H = await hist(), P = await pluvio();
  const { h, arch } = setup(H, P, ['A', 'B'], '2024-12-01');
  const rows = [
    { indicativo: 'A', fecha: '2024-11-30', prec: '1,0' }, { indicativo: 'A', fecha: '2024-10-31', prec: '1,0' },
    { indicativo: 'B', fecha: '2024-11-30', tmed: '10,0' }, { indicativo: 'B', fecha: '2024-11-29' } // sin ningún valor
  ];
  H.ingestChunk(h, arch, { from: '2024-11-16', to: '2024-11-30' }, rows);
  assert.equal(H.monthCount(h), 2, 'A y B en noviembre; el día de B sin valores no cuenta');
  H.ingestChunk(h, arch, { from: '2024-10-17', to: '2024-10-31' }, rows);
  assert.equal(H.monthCount(h), 3);
  assert.deepEqual(H.guardShrink(3, 3), { keep: false, before: 3, after: 3 });
  assert.deepEqual(H.guardShrink(3, 4), { keep: false, before: 3, after: 4 });
  assert.deepEqual(H.guardShrink(3, 2), { keep: true, before: 3, after: 2 });
  assert.equal(H.guardShrink(3, 2, true).keep, false, 'HIST_RESET=1');
  assert.equal(H.guardShrink(0, 0).keep, false, 'primera vez');
});

test('lectura de los archivos publicados: 404 es la primera vez, cualquier otro fallo se reintenta y se lanza', async () => {
  const H = await hist();
  const json = { version: 1, stations: {} };
  const gz = zlib.gzipSync(JSON.stringify(json));
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
  const calls = [];
  const sleeps = [];
  const io = (...answers) => ({ fetch: async (url) => { calls.push(url); const a = answers.shift(); if (a instanceof Error) throw a; return a; }, sleep: async (ms) => { sleeps.push(ms); } });

  assert.equal(await H.loadGz('https://x.github.io/c/agua/', 'pluvio/historico.json.gz', io(res(404, Buffer.alloc(0)))), null);
  assert.equal(calls[0], 'https://x.github.io/c/agua/pluvio/historico.json.gz');
  assert.equal(calls.length, 1, '404: sin reintentos');

  calls.length = 0;
  const ok = await H.loadGz('https://x/agua', 'pluvio/historico.json.gz', io(res(503, Buffer.alloc(0)), new Error('ECONNRESET'), res(200, gz)));
  assert.deepEqual(ok.json, json);
  assert.deepEqual(ok.buf, gz);
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);

  calls.length = 0;
  await assert.rejects(H.loadGz('https://x/agua', 'pluvio/archivo.json.gz', io(res(500, Buffer.alloc(0)), res(502, Buffer.alloc(0)), res(500, Buffer.alloc(0)))), /archivo\.json\.gz: HTTP 500/);
  assert.equal(calls.length, 3, 'tres intentos');
  await assert.rejects(H.loadGz('https://x/agua', 'a.gz', io(res(200, Buffer.from('no es gzip')), res(200, Buffer.from('no es gzip')), res(200, Buffer.from('no es gzip')))), /a\.gz/, 'un archivo corrupto tampoco es «primera vez»');

  // Carpeta local.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubasco-hist-'));
  try {
    assert.equal(await H.loadGz(dir, 'pluvio/historico.json.gz', { sleep: async () => {} }), null, 'ENOENT: primera vez');
    fs.mkdirSync(path.join(dir, 'pluvio'));
    fs.writeFileSync(path.join(dir, 'pluvio', 'historico.json.gz'), gz);
    assert.deepEqual((await H.loadGz(dir, 'pluvio/historico.json.gz', { sleep: async () => {} })).json, json);
    fs.mkdirSync(path.join(dir, 'pluvio', 'archivo.json.gz')); // existe pero no se puede leer como archivo (EISDIR)
    await assert.rejects(H.loadGz(dir, 'pluvio/archivo.json.gz', { sleep: async () => {}, tries: 2 }), /archivo\.json\.gz/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  assert.throws(() => H.parseHistory({ version: 2, stations: {} }), /formato desconocido/);
  assert.throws(() => H.parseHistory(null), /formato desconocido/);
  const p = H.parseHistory(json);
  assert.deepEqual([p.normals, p.records, p.done, p.edge], [{}, {}, false, null]);
});
