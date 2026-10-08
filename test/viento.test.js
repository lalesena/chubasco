// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const W = require('../src/shared/windgrid');
const grib = () => import(pathToFileURL(path.join(__dirname, '../scripts/viento/grib2.mjs')).href);
// Recorte real de GFS (pasada del 8-10-2026 a las 12 UTC, +18 h) alrededor de Madrid: 40–41 N, 4,5–3 O.
const FIXTURE = path.join(__dirname, 'fixtures/viento/gfs-madrid.grib2');

test('viento: el lector GRIB2 saca u, v y racha del recorte de NOMADS', async () => {
  const { parseGrib2 } = await grib();
  const msgs = parseGrib2(fs.readFileSync(FIXTURE));
  assert.equal(msgs.length, 3);
  const by = (num) => msgs.find((m) => m.cat === 2 && m.num === num);
  const u = by(2), v = by(3), gust = by(22);
  assert.ok(u && v && gust, 'u, v y racha');
  assert.equal(u.surface, 103);
  assert.equal(u.level, 10, 'a 10 m');
  assert.equal(gust.surface, 1, 'racha en superficie');
  for (const m of msgs) {
    assert.equal(new Date(m.refTime).toISOString(), '2026-10-08T12:00:00.000Z');
    assert.equal(m.hour, 18);
    assert.deepEqual([m.grid.ni, m.grid.nj, m.grid.la1, m.grid.la2, m.grid.lo1, m.grid.lo2, m.grid.scan], [7, 5, 40, 41, 355.5, 357, 64]);
  }
  // Primer punto (40 N, 4,5 O; el barrido va de sur a norte). Valores de referencia de este fichero (la rejilla
  // completa de esa misma hora cuadra con lo que da Open-Meteo para GFS en Berlín, Tarifa o el golfo de León).
  assert.ok(Math.abs(u.values[0] - -2.602) < 0.01, `u = ${u.values[0]}`);
  assert.ok(Math.abs(v.values[0] - -0.945) < 0.01, `v = ${v.values[0]}`);
  assert.ok(Math.abs(gust.values[0] - 3.215) < 0.01, `racha = ${gust.values[0]}`);
  for (const m of msgs) for (const x of m.values) assert.ok(Math.abs(x) < 60, 'valores de viento razonables');
});

test('viento: el recorte se reordena de norte a sur y se rechaza otra rejilla', async () => {
  const { parseGrib2, toNorthUp } = await grib();
  const [, u] = parseGrib2(fs.readFileSync(FIXTURE));
  const grid = { west: -4.5, north: 41, step: 0.25, cols: 7, rows: 5 };
  const out = toNorthUp(u, grid);
  // La primera fila de la salida es la de 41 N (la última del fichero).
  assert.deepEqual(Array.from(out.subarray(0, 7)), Array.from(u.values.subarray(28, 35)));
  assert.deepEqual(Array.from(out.subarray(28, 35)), Array.from(u.values.subarray(0, 7)));
  assert.throws(() => toNorthUp(u, { ...grid, west: -4.25 }), /rejilla/);
  assert.throws(() => toNorthUp(u, { ...grid, cols: 8 }), /rejilla/);
});

test('viento: el lector GRIB2 no da por buenos ficheros que no sabe leer', async () => {
  const { parseGrib2 } = await grib();
  const buf = Buffer.from(fs.readFileSync(FIXTURE));
  assert.throws(() => parseGrib2(Buffer.from('<html>404</html>')), /GRIB/);
  // Empaquetado distinto del simple (p. ej. el CCSDS del ECMWF, plantilla 5.42).
  const bad = Buffer.from(buf);
  let o = 16;
  while (bad[o + 4] !== 5) o += bad.readUInt32BE(o);
  bad.writeUInt16BE(42, o + 9);
  assert.throws(() => parseGrib2(bad), /empaquetado 42/);
});

test('viento: codificar y decodificar una hora conserva el viento (pasos de 0,5 m/s)', () => {
  const grid = { west: 0, north: 10, step: 0.25, cols: 30, rows: 20 };
  const n = grid.cols * grid.rows;
  const u = new Float32Array(n), v = new Float32Array(n), gust = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = 12 * Math.sin(i / 37) - 3;
    v[i] = 9 * Math.cos(i / 23) + 1.3;
    gust[i] = Math.hypot(u[i], v[i]) * 1.5 + 2;
  }
  u[5] = 90; v[6] = -90; gust[7] = NaN; // fuera de rango y sin dato
  const bytes = W.encode({ u, v, gust }, grid);
  assert.equal(bytes.length, 3 * n);
  const d = W.decode(bytes, grid);
  for (let i = 8; i < n; i++) {
    assert.ok(Math.abs(d.u[i] - u[i]) <= 0.25 + 1e-6, `u[${i}]`);
    assert.ok(Math.abs(d.v[i] - v[i]) <= 0.25 + 1e-6, `v[${i}]`);
    assert.ok(Math.abs(d.gust[i] - gust[i]) <= 0.25 + 1e-6, `racha[${i}]`);
    assert.ok(Math.abs(d.speed[i] - Math.hypot(d.u[i], d.v[i])) < 1e-5);
  }
  assert.equal(d.u[5], 63.5, 'se recorta al máximo');
  assert.equal(d.v[6], -63.5);
  assert.ok(d.gust[7] >= d.speed[7], 'la racha nunca queda por debajo del viento medio');
  // Las diferencias por filas hacen que comprima mucho mejor que los valores tal cual.
  const plain = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) { plain[i] = Math.round(u[i] / 0.5) & 255; plain[n + i] = Math.round(v[i] / 0.5) & 255; plain[2 * n + i] = Math.round(gust[i] / 0.5) & 255; }
  assert.ok(zlib.gzipSync(bytes).length < zlib.gzipSync(plain).length);
  assert.throws(() => W.decode(bytes.subarray(1), grid), /bytes/);
});

test('viento: gunzip e inflate descomprimen como en el navegador (y dejan pasar lo ya descomprimido)', async () => {
  const raw = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255);
  const gz = zlib.gzipSync(raw);
  assert.deepEqual(await W.gunzip(gz), raw);
  assert.deepEqual(await W.inflate(new Uint8Array(gz)), raw);
  assert.deepEqual(await W.inflate(raw), raw);
});

test('viento: interpolación, dirección de la que sopla y fuera de la rejilla', () => {
  const grid = { west: -10, north: 50, step: 1, cols: 3, rows: 3 };
  const f = (vals) => Float32Array.from(vals);
  // Viento del norte (sopla hacia el sur: v < 0) en toda la rejilla, más fuerte al este.
  const step = { u: f([0, 0, 0, 0, 0, 0, 0, 0, 0]), v: f([-2, -4, -6, -2, -4, -6, -2, -4, -6]), gust: f([3, 5, 9, 3, 5, 9, 3, 5, 9]) };
  const s = W.sample(step, grid, 49.5, -9.5);
  assert.ok(Math.abs(s.speed - 3) < 1e-6);
  assert.ok(Math.abs(s.from - 0) < 1e-6 || Math.abs(s.from - 360) < 1e-6, `del norte: ${s.from}`);
  assert.ok(Math.abs(s.gust - 4) < 1e-6);
  assert.equal(W.sample(step, grid, 50.5, -9), null, 'al norte de la rejilla');
  assert.equal(W.sample(step, grid, 49, -12), null, 'al oeste');
  assert.ok(W.sample(step, grid, 48, -8), 'la esquina sureste también vale');
  const dir = (u, v) => W.sample({ u: f(Array(9).fill(u)), v: f(Array(9).fill(v)), gust: f(Array(9).fill(0)) }, grid, 49, -9).from;
  assert.ok(Math.abs(dir(5, 0) - 270) < 1e-6, 'u > 0: del oeste');
  assert.ok(Math.abs(dir(-5, 0) - 90) < 1e-6, 'u < 0: del este');
  assert.ok(Math.abs(dir(0, 5) - 180) < 1e-6, 'v > 0: del sur');
  assert.ok(Math.abs(dir(-3, -3) - 45) < 1e-6, 'hacia el suroeste: del noreste');
});

test('viento: escala Beaufort y colores', () => {
  assert.equal(W.beaufort(0), 0);
  assert.equal(W.beaufort(0.4), 0);
  assert.equal(W.beaufort(0.5), 1);
  assert.equal(W.beaufort(5.4), 3);
  assert.equal(W.beaufort(5.5), 4);
  assert.equal(W.beaufort(17.2), 8, 'temporal desde 17,2 m/s (62 km/h)');
  assert.equal(W.beaufort(40), 12);
  assert.deepEqual(W.color(0), W.ANCHORS[0][1]);
  assert.deepEqual(W.color(1000), W.ANCHORS[W.ANCHORS.length - 1][1]);
  const lut = W.colorTable();
  assert.equal(lut.length, W.LUT_MAX / W.LUT_STEP + 1);
  assert.equal(lut[0] >>> 24, 255, 'opaco');
  const [r, g, b] = W.color(6);
  assert.equal(lut[6 / W.LUT_STEP], ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0);
});

test('viento: la rejilla publicada cubre Europa con Canarias', () => {
  const g = W.gridOf();
  assert.deepEqual(g, { west: -32, north: 72, step: 0.25, cols: 309, rows: 181 });
  const at = (lat, lon) => W.cell(g, lat, lon) !== null;
  assert.ok(at(28.1, -15.4), 'Las Palmas');
  assert.ok(at(40.4, -3.7), 'Madrid');
  assert.ok(at(64.1, -21.9), 'Reikiavik');
  assert.ok(at(60.2, 24.9), 'Helsinki');
  assert.ok(!at(25, -15), 'más al sur de Canarias');
});

test('viento: el generador copia la pasada ya publicada si NOAA no tiene otra', async (t) => {
  // Lo publicado (en una carpeta) con la pasada más reciente posible: el
  // generador no debe pedir nada a NOMADS y tiene que copiarla tal cual.
  const os = require('os');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chubasco-viento-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const grid = W.gridOf();
  const n = grid.rows * grid.cols;
  const CYCLE = 6 * 3600000;
  const t0 = Math.floor(Date.now() / CYCLE) * CYCLE;
  const d = new Date(t0);
  const p2 = (x) => String(x).padStart(2, '0');
  const run = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}`;
  const prev = path.join(tmp, 'prev');
  fs.mkdirSync(path.join(prev, run), { recursive: true });
  const steps = [];
  for (const h of [0, 1, 2]) {
    const u = new Float32Array(n).fill(h + 1), v = new Float32Array(n).fill(-2), gust = new Float32Array(n).fill(9);
    const f = `${run}/f${String(h).padStart(3, '0')}.gz`;
    fs.writeFileSync(path.join(prev, f), zlib.gzipSync(W.encode({ u, v, gust }, grid)));
    steps.push({ h, t: t0 + h * 3600000, f });
  }
  fs.writeFileSync(path.join(prev, 'index.json'), JSON.stringify({ v: 1, model: 'GFS', run, runTime: t0, generated: 0, grid, scale: W.SCALE, steps }));
  const out = path.join(tmp, 'out');
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/viento/datos.mjs'), out, prev], { stdio: 'pipe' });
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(idx.run, run);
  assert.deepEqual(idx.steps.map((s) => s.f), steps.map((s) => s.f));
  const back = W.decode(zlib.gunzipSync(fs.readFileSync(path.join(out, steps[2].f))), idx.grid);
  assert.equal(back.u[123], 3);
  assert.equal(back.v[123], -2);
});
