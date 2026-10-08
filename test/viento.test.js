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
  const { parseGrib2, extract } = await grib();
  const [, u] = parseGrib2(fs.readFileSync(FIXTURE));
  const grid = { west: -4.5, north: 41, step: 0.25, cols: 7, rows: 5 };
  const out = extract(u, grid);
  // La primera fila de la salida es la de 41 N (la última del fichero).
  assert.deepEqual(Array.from(out.subarray(0, 7)), Array.from(u.values.subarray(28, 35)));
  assert.deepEqual(Array.from(out.subarray(28, 35)), Array.from(u.values.subarray(0, 7)));
  // Una zona dentro del fichero: 40,25–40,75 N, 4,25–3,75 O.
  const sub = extract(u, { west: -4.25, north: 40.75, step: 0.25, cols: 3, rows: 3 });
  assert.deepEqual(Array.from(sub.subarray(0, 3)), Array.from(u.values.subarray(3 * 7 + 1, 3 * 7 + 4)));
  assert.deepEqual(Array.from(sub.subarray(6, 9)), Array.from(u.values.subarray(7 + 1, 7 + 4)));
  assert.throws(() => extract(u, { ...grid, west: -4.25 }), /rejilla/, 'se sale por el este');
  assert.throws(() => extract(u, { ...grid, north: 41.25 }), /rejilla/, 'se sale por el norte');
  assert.throws(() => extract(u, { ...grid, west: -4.4 }), /rejilla/, 'puntos que no coinciden');
  assert.throws(() => extract(u, { ...grid, step: 0.5, cols: 3, rows: 2 }), /resolución/);
});

test('viento: el recorte de una rejilla global da la vuelta al meridiano 180 (ECMWF)', async () => {
  const { extract } = await grib();
  // Como el ECMWF: de 90 N a 90 S y empezando en 180°, cada 1° (el valor dice la longitud y la latitud).
  const ni = 360, nj = 181;
  const values = new Float32Array(ni * nj);
  for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) values[j * ni + i] = (((180 + i) % 360 + 540) % 360 - 180) * 1000 + (90 - j);
  const msg = { grid: { ni, nj, la1: 90, lo1: 180, la2: -90, lo2: 179, di: 1, dj: 1, scan: 0 }, values };
  const out = extract(msg, { west: -2, north: 41, step: 1, cols: 5, rows: 2 });
  assert.deepEqual(Array.from(out), [-2000 + 41, -1000 + 41, 41, 1000 + 41, 2000 + 41, -2000 + 40, -1000 + 40, 40, 1000 + 40, 2000 + 40]);
});

test('viento: el lector GRIB2 no da por buenos ficheros que no sabe leer', async () => {
  const { parseGrib2 } = await grib();
  const buf = Buffer.from(fs.readFileSync(FIXTURE));
  assert.throws(() => parseGrib2(Buffer.from('<html>404</html>')), /GRIB/);
  // Otro empaquetado (p. ej. JPEG 2000, plantilla 5.40).
  const bad = Buffer.from(buf);
  let o = 16;
  while (bad[o + 4] !== 5) o += bad.readUInt32BE(o);
  bad.writeUInt16BE(40, o + 9);
  assert.throws(() => parseGrib2(bad), /empaquetado 40/);
  // Horas en minutos (como el DWD): +18 h = 1080 min.
  const mins = Buffer.from(buf);
  o = 16;
  while (mins[o + 4] !== 4) o += mins.readUInt32BE(o);
  mins[o + 17] = 0;
  mins.writeUInt32BE(1080, o + 18);
  assert.equal(parseGrib2(mins)[0].hour, 18);
  mins[o + 17] = 13; // segundos: no admitido
  assert.throws(() => parseGrib2(mins), /unidad de tiempo 13/);
});

// ---------------------------------------------------------------------------
// CCSDS (plantilla 5.42, la del ECMWF y el DWD): un codificador mínimo para
// la prueba, que elige a propósito el tipo de cada bloque.

class BitWriter {
  constructor() { this.bits = []; }
  put(v, n) { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2); }
  fs(n) { for (let i = 0; i < n; i++) this.bits.push(0); this.bits.push(1); }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}
// Preprocesado: cada intervalo empieza con la muestra tal cual; las demás, diferencias plegadas.
function mapRsi(x, xmax) {
  const out = [x[0]];
  for (let i = 1; i < x.length; i++) {
    const prev = x[i - 1], delta = x[i] - prev, theta = Math.min(prev, xmax - prev);
    out.push(delta >= 0 && delta <= theta ? 2 * delta : delta < 0 && -delta <= theta ? -2 * delta - 1 : theta + Math.abs(delta));
  }
  return out;
}
/** plan: un tipo por bloque: 'uncomp', ['split', k], 'se', ['zero', n] o ['zero', 'ros']. */
function aecEncode(samples, { bps, block, rsi, plan }) {
  const w = new BitWriter();
  const idLen = bps > 16 ? 5 : bps > 8 ? 4 : 3;
  const xmax = 2 ** bps - 1;
  let p = 0;
  for (let start = 0; start < samples.length; start += block * rsi) {
    const x = samples.slice(start, start + block * rsi);
    while (x.length % block) x.push(x[x.length - 1]); // el último bloque, completado repitiendo
    const d = mapRsi(x, xmax);
    for (let b = 0; b < x.length / block;) {
      const mode = plan[p++];
      const v = d.slice(b * block, (b + 1) * block);
      const ref = b === 0 ? 1 : 0;
      const kind = Array.isArray(mode) ? mode[0] : mode;
      if (kind === 'uncomp') {
        w.put((1 << idLen) - 1, idLen);
        for (const s of v) w.put(s, bps);
        b++;
      } else if (kind === 'split') {
        const k = mode[1];
        w.put(k + 1, idLen);
        if (ref) w.put(v[0], bps);
        for (let i = ref; i < block; i++) w.fs(Math.floor(v[i] / 2 ** k));
        for (let i = ref; i < block; i++) w.put(v[i] % 2 ** k, k);
        b++;
      } else if (kind === 'se') {
        w.put(0, idLen); w.put(1, 1);
        if (ref) w.put(v[0], bps);
        for (let i = 0; i < block; i += 2) {
          const a = i === 0 && ref ? 0 : v[i], c = v[i + 1];
          w.fs(((a + c) * (a + c + 1)) / 2 + c);
        }
        b++;
      } else {
        const n = mode[1] === 'ros' ? x.length / block - b : mode[1];
        for (let i = ref; i < n * block; i++) assert.equal(d[b * block + i], 0, 'un bloque de ceros solo puede llevar ceros');
        w.put(0, idLen); w.put(0, 1);
        if (ref) w.put(v[0], bps);
        w.fs(mode[1] === 'ros' ? 4 : n < 5 ? n - 1 : n);
        b += n;
      }
    }
  }
  return w.bytes();
}

test('viento: el lector CCSDS deshace todos los tipos de bloque y el preprocesado', async () => {
  const { aecDecode } = await grib();
  const bps = 12, block = 8, rsi = 4, flags = 8 | 4 | 2; // preprocesado, MSB y 3 bytes, como el ECMWF y el DWD
  const ramp = (a, n, step) => Array.from({ length: n }, (_, i) => a + i * step);
  const samples = [
    // Intervalo 1: bloque partido (k = 2), sin comprimir, segunda extensión y de ceros.
    ...[1000, 1013, 990, 1002, 1040, 1001, 1003, 999], ...[3000, 120, 4095, 0, 2048, 7, 4000, 5],
    ...ramp(5, 8, 1), ...Array(8).fill(12),
    // Intervalo 2: todo igual a la referencia (ceros «hasta el final del segmento»).
    ...Array(32).fill(2500),
    // Intervalo 3: saltos grandes cerca de los extremos (las dos ramas del plegado) y varios bloques de ceros.
    ...[4090, 100, 4095, 0, 4094, 3, 4000, 4095], ...Array(24).fill(4095),
    // Intervalo 4, incompleto: 13 muestras (el último bloque va relleno).
    ...ramp(300, 13, -7)
  ];
  const plan = [['split', 2], 'uncomp', 'se', ['zero', 1], ['zero', 'ros'], ['split', 10], ['zero', 3], 'uncomp', ['split', 3]];
  const bytes = aecEncode(samples, { bps, block, rsi, plan });
  const out = aecDecode(bytes, 0, bytes.length, samples.length, bps, block, rsi, flags);
  assert.deepEqual(Array.from(out), samples);
  // Más de 4 bloques de ceros seguidos (el código salta el 5, que es «hasta el final del segmento»).
  const long = [...Array(8).fill(7), ...Array(56).fill(7)];
  const b2 = aecEncode(long, { bps, block, rsi: 8, plan: [['zero', 6], 'uncomp', ['split', 0]] });
  assert.deepEqual(Array.from(aecDecode(b2, 0, b2.length, long.length, bps, block, 8, flags)), long);
  assert.throws(() => aecDecode(bytes, 0, bytes.length, samples.length, bps, block, rsi, flags | 1), /signo/);
  assert.throws(() => aecDecode(bytes, 0, 10, samples.length, bps, block, rsi, flags), /cortados/);
});

test('viento: un mensaje GRIB2 con CCSDS se lee igual que con empaquetado simple', async () => {
  const { parseGrib2 } = await grib();
  // El recorte real de GFS, con la sección de datos recomprimida en CCSDS (plantilla 5.42).
  const buf = fs.readFileSync(FIXTURE);
  const total = Number(buf.readBigUInt64BE(8));
  const msg = buf.subarray(0, total);
  const secs = [];
  for (let o = 16; o < total - 4; o += msg.readUInt32BE(o)) secs.push(msg.subarray(o, o + msg.readUInt32BE(o)));
  const s5 = secs.find((x) => x[4] === 5), s7 = secs.find((x) => x[4] === 7);
  const n = s5.readUInt32BE(5), nbits = s5[19];
  const ints = [];
  for (let i = 0, bit = 5 * 8; i < n; i++) { let v = 0; for (let k = 0; k < nbits; k++, bit++) v = v * 2 + ((s7[bit >> 3] >> (7 - (bit & 7))) & 1); ints.push(v); }
  const block = 8, rsi = 2;
  const plan = [];
  for (let i = 0; i < Math.ceil(n / block); i++) plan.push(i % 2 ? 'uncomp' : ['split', 4]);
  const data = aecEncode(ints, { bps: nbits, block, rsi, plan });
  const n5 = Buffer.alloc(25);
  s5.copy(n5, 0, 0, 21);
  n5.writeUInt32BE(25, 0);
  n5.writeUInt16BE(42, 9);
  n5[21] = 14; n5[22] = block; n5.writeUInt16BE(rsi, 23);
  const n7 = Buffer.concat([Buffer.from([0, 0, 0, 0, 7]), Buffer.from(data)]);
  n7.writeUInt32BE(n7.length, 0);
  const body = Buffer.concat(secs.map((x) => (x === s5 ? n5 : x === s7 ? n7 : x)));
  const head = Buffer.from(msg.subarray(0, 16));
  head.writeBigUInt64BE(BigInt(16 + body.length + 4), 8);
  const ccsds = Buffer.concat([head, body, Buffer.from('7777')]);
  const [a] = parseGrib2(msg), [b] = parseGrib2(ccsds);
  assert.deepEqual(Array.from(b.values), Array.from(a.values));
  assert.deepEqual(b.grid, a.grid);
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

test('viento: las rejillas publicadas (ECMWF y GFS en Europa con Canarias; ICON-EU en la península)', () => {
  assert.deepEqual(W.MODELS.map((m) => m.id), ['ecmwf', 'icon-eu', 'gfs']);
  const grid = (id) => W.MODELS.find((m) => m.id === id).grid;
  const g = grid('ecmwf');
  assert.deepEqual(g, { west: -32, north: 72, step: 0.25, cols: 309, rows: 181 });
  assert.deepEqual(grid('gfs'), g);
  const at = (gr, lat, lon) => W.cell(gr, lat, lon) !== null;
  assert.ok(at(g, 28.1, -15.4), 'Las Palmas');
  assert.ok(at(g, 40.4, -3.7), 'Madrid');
  assert.ok(at(g, 64.1, -21.9), 'Reikiavik');
  assert.ok(at(g, 60.2, 24.9), 'Helsinki');
  assert.ok(!at(g, 25, -15), 'más al sur de Canarias');
  const ic = grid('icon-eu');
  assert.deepEqual(ic, { west: -10.5, north: 46, step: 0.0625, cols: 265, rows: 185 });
  for (const [name, lat, lon] of [['Madrid', 40.4, -3.7], ['Palma', 39.6, 2.65], ['Lisboa', 38.7, -9.1], ['Tarifa', 36.0, -5.6], ['A Coruña', 43.4, -8.4], ['Girona', 42.0, 2.8], ['Melilla', 35.3, -2.9]]) assert.ok(at(ic, lat, lon), name);
  assert.ok(!at(ic, 28.1, -15.4), 'Canarias, fuera de ICON-EU');
  // Los puntos de la zona de ICON-EU coinciden con los de su rejilla (29,5 N, 23,5 O, cada 0,0625°).
  for (const v of [(ic.north - 29.5) / ic.step, (ic.west + 23.5) / ic.step]) assert.equal(v, Math.round(v));
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
  fs.mkdirSync(path.join(prev, 'gfs', run), { recursive: true });
  const steps = [];
  for (const h of [0, 1, 2]) {
    const u = new Float32Array(n).fill(h + 1), v = new Float32Array(n).fill(-2), gust = new Float32Array(n).fill(9);
    const f = `${run}/f${String(h).padStart(3, '0')}.gz`;
    fs.writeFileSync(path.join(prev, 'gfs', f), zlib.gzipSync(W.encode({ u, v, gust }, grid)));
    steps.push({ h, t: t0 + h * 3600000, f });
  }
  fs.writeFileSync(path.join(prev, 'gfs', 'index.json'), JSON.stringify({ v: 1, model: 'gfs', run, runTime: t0, generated: 0, grid, scale: W.SCALE, steps }));
  const out = path.join(tmp, 'out');
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/viento/datos.mjs'), out, prev, 'gfs'], { stdio: 'pipe' });
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'gfs', 'index.json'), 'utf8'));
  assert.equal(idx.run, run);
  assert.deepEqual(idx.steps.map((s) => s.f), steps.map((s) => s.f));
  const back = W.decode(zlib.gunzipSync(fs.readFileSync(path.join(out, 'gfs', steps[2].f))), idx.grid);
  assert.equal(back.u[123], 3);
  assert.equal(back.v[123], -2);
});
