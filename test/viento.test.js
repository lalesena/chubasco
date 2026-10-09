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
const M = require('../src/shared/metgrid');
const P = require('../src/shared/palette');
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
    const f = `${run}/f${String(h).padStart(3, '0')}.gz`, m = `${run}/m${String(h).padStart(3, '0')}.gz`;
    fs.writeFileSync(path.join(prev, 'gfs', f), zlib.gzipSync(W.encode({ u, v, gust }, grid)));
    // Con la lluvia y la temperatura ya publicadas (si no, el generador las pediría a NOMADS).
    fs.writeFileSync(path.join(prev, 'gfs', m), zlib.gzipSync(M.encode({ rain: new Float32Array(n).fill(h * 0.5), temp: new Float32Array(n).fill(10 + h) }, grid)));
    steps.push(h ? { h, t: t0 + h * 3600000, f, m, span: 1 } : { h, t: t0, f, m });
  }
  fs.writeFileSync(path.join(prev, 'gfs', 'index.json'), JSON.stringify({ v: 1, model: 'gfs', run, runTime: t0, generated: 0, grid, scale: W.SCALE, met: M.META, steps }));
  const out = path.join(tmp, 'out');
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/viento/datos.mjs'), out, prev, 'gfs'], { stdio: 'pipe' });
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'gfs', 'index.json'), 'utf8'));
  assert.equal(idx.run, run);
  assert.deepEqual(idx.steps.map((s) => s.f), steps.map((s) => s.f));
  const back = W.decode(zlib.gunzipSync(fs.readFileSync(path.join(out, 'gfs', steps[2].f))), idx.grid);
  assert.equal(back.u[123], 3);
  assert.equal(back.v[123], -2);
  // La lluvia y la temperatura se copian con su duración, y el índice sigue siendo el de siempre para las versiones antiguas.
  assert.deepEqual(idx.steps.map((s) => s.m), steps.map((s) => s.m));
  assert.deepEqual(idx.steps.map((s) => s.span), [undefined, 1, 1]);
  assert.deepEqual(idx.met, M.META);
  assert.equal(idx.v, 1);
  const met = M.decode(zlib.gunzipSync(fs.readFileSync(path.join(out, 'gfs', steps[2].m))), idx.grid);
  assert.ok(Math.abs(met.rain[7] - 1) < 0.05 && met.temp[7] === 12);
});

// ---------------------------------------------------------------------------
// Lluvia y temperatura del modo «Previsión»

const metmod = () => import(pathToFileURL(path.join(__dirname, '../scripts/viento/met.mjs')).href);
// Recortes reales de GFS (pasada del 9-10-2026 a las 00 UTC) sobre el Adriático sur, con lluvia: 40,5–41,5 N, 18,5–20 E.
const RAIN = (h) => path.join(__dirname, `fixtures/viento/gfs-lluvia-f${String(h).padStart(3, '0')}.grib2`);
const RAIN_GRID = { west: 18.5, north: 41.5, step: 0.25, cols: 7, rows: 5 };
const RUN_T = Date.UTC(2026, 9, 9, 0);
const validAt = (h) => (m) => assert.ok(Math.abs(m.hour - h) < 1e-6 && m.refTime === RUN_T, `hora ${m.hour}`);

test('lluvia: el lector lee la plantilla 4.8 (el principio del intervalo y su duración) del recorte de GFS', async () => {
  const { parseGrib2 } = await grib();
  // +12 h: dos mensajes de lluvia, el del tramo de 6 h en curso (6–12) y el acumulado desde la pasada (0–12).
  const msgs = parseGrib2(fs.readFileSync(RAIN(12)));
  const rain = msgs.filter((m) => m.cat === 1 && m.num === 8);
  assert.deepEqual(rain.map((m) => [m.discipline, m.surface, m.stat, m.start, m.span, m.hour]).sort((a, b) => a[3] - b[3]),
    [[0, 1, 1, 0, 12, 12], [0, 1, 1, 6, 6, 12]], 'la «hora de previsión» es el principio; la hora válida, el final');
  // Con la temperatura: la del suelo (nivel 1) y la de 2 m (nivel 103), que es la que se usa.
  const temps = msgs.filter((m) => m.cat === 0 && m.num === 0);
  assert.deepEqual(temps.map((m) => [m.surface, m.level, m.hour]).sort(), [[1, 0, 12], [103, 2, 12]]);
  assert.equal(temps[0].start, undefined, 'la temperatura es de un instante');
  for (const m of msgs) assert.equal(new Date(m.refTime).toISOString(), '2026-10-09T00:00:00.000Z');
  // +7 h: el tramo 6–7 y el 0–7. +6 h: el 0–6 (dos veces, es el mismo).
  const at7 = parseGrib2(fs.readFileSync(RAIN(7))).filter((m) => m.cat === 1);
  assert.deepEqual(at7.map((m) => [m.start, m.span, m.hour]).sort((a, b) => a[0] - b[0]), [[0, 7, 7], [6, 1, 7]]);
  assert.deepEqual(parseGrib2(fs.readFileSync(RAIN(6))).filter((m) => m.cat === 1).map((m) => [m.start, m.span, m.hour]), [[0, 6, 6], [0, 6, 6]]);
  // Los acumulados cuadran: 0–12 = 0–6 + 6–12 (y lo mismo a +7 h), salvo el redondeo del empaquetado de NOAA (1/16 mm).
  const a6 = parseGrib2(fs.readFileSync(RAIN(6))).find((m) => m.cat === 1);
  const whole = rain.find((m) => m.start === 0), part = rain.find((m) => m.start === 6);
  let max = 0;
  for (let i = 0; i < whole.values.length; i++) { max = Math.max(max, whole.values[i]); assert.ok(Math.abs(whole.values[i] - (a6.values[i] + part.values[i])) < 0.13, `punto ${i}`); }
  assert.ok(max > 20, `llovió ${max} mm`);
});

test('lluvia: el intervalo con las horas en minutos (como el DWD) y un tramo que no empieza en 0', async () => {
  const { parseGrib2 } = await grib();
  const buf = Buffer.from(fs.readFileSync(RAIN(12)));
  // El primer mensaje de lluvia (6–12): hora de previsión 360 min y duración 360 min.
  let p = 0;
  for (;;) {
    const total = Number(buf.readBigUInt64BE(p + 8));
    let o = p + 16;
    while (buf[o + 4] !== 4) o += buf.readUInt32BE(o);
    if (buf.readUInt16BE(o + 7) === 8 && buf.readUInt32BE(o + 18) === 6) {
      buf[o + 17] = 0; buf.writeUInt32BE(360, o + 18); buf[o + 48] = 0; buf.writeUInt32BE(360, o + 49);
      break;
    }
    p += total;
    assert.ok(p < buf.length, 'no hay un mensaje 6–12');
  }
  const m = parseGrib2(buf).find((x) => x.start === 6);
  assert.deepEqual([m.start, m.span, m.hour], [6, 6, 12]);
});

test('lluvia: de los mensajes de una hora salen la temperatura a 2 m y los acumulados (el tramo de 6 h de GFS también)', async () => {
  const { parseGrib2 } = await grib();
  const { pickMet } = await metmod();
  const got = pickMet(parseGrib2(fs.readFileSync(RAIN(7))), 'gfs', RAIN_GRID, 7, validAt(7));
  assert.equal(got.temp.length, 35);
  assert.ok(got.temp.every((c) => c > 15 && c < 25), 'grados Celsius, no kelvin ni la temperatura del suelo');
  assert.deepEqual(got.acc.map((a) => a.start).sort(), [0, 6]);
  // De norte a sur: la primera fila es la de 41,5 N, que es la última del fichero.
  const raw = parseGrib2(fs.readFileSync(RAIN(7))).find((m) => m.cat === 1 && m.start === 0);
  assert.deepEqual(Array.from(got.acc.find((a) => a.start === 0).values.subarray(0, 7)), Array.from(raw.values.subarray(28, 35)));
  // A +0 h no hay lluvia; una hora equivocada o un fichero sin la variable se rechazan.
  assert.equal(pickMet(parseGrib2(fs.readFileSync(RAIN(7))), 'gfs', RAIN_GRID, 0, validAt(7)).acc, null);
  assert.throws(() => pickMet(parseGrib2(fs.readFileSync(RAIN(7))), 'gfs', RAIN_GRID, 8, validAt(8)), /hora/);
  assert.throws(() => pickMet(parseGrib2(fs.readFileSync(FIXTURE)), 'gfs', RAIN_GRID, 18, validAt(18)), /temperatura/);
  const onlyT = parseGrib2(fs.readFileSync(RAIN(7))).filter((m) => m.cat === 0);
  assert.throws(() => pickMet(onlyT, 'gfs', RAIN_GRID, 7, validAt(7)), /falta la lluvia/);
  // Con otro código de lluvia (ECMWF usa 1/193) no se confunde.
  assert.throws(() => pickMet(parseGrib2(fs.readFileSync(RAIN(7))), 'ecmwf', RAIN_GRID, 7, validAt(7)), /falta la lluvia/);
});

// Mensajes sintéticos con la forma de los de cada modelo: una rejilla de 3 × 2 puntos.
const FAKE_GRID = { west: 0, north: 41, step: 1, cols: 3, rows: 2 };
const fake = (num, start, span, h, vals, extra = {}) => ({
  discipline: 0, cat: 1, num, surface: 1, level: 0, stat: 1, start, span, hour: start + span, refTime: RUN_T,
  grid: { ni: 3, nj: 2, la1: 41, lo1: 0, la2: 40, lo2: 2, di: 1, dj: 1, scan: 0 }, values: Float32Array.from(vals), ...extra
});
const temp2m = (kelvin) => ({ discipline: 0, cat: 0, num: 0, surface: 103, level: 2, hour: 0, refTime: RUN_T, grid: { ni: 3, nj: 2, la1: 41, lo1: 0, la2: 40, lo2: 2, di: 1, dj: 1, scan: 0 }, values: Float32Array.from(Array(6).fill(kelvin)) });

test('lluvia: ECMWF (en metros) e ICON-EU (en mm) acumulan desde la pasada: la media de cada tramo, y si falta una hora el tramo se alarga', async () => {
  const { pickMet, ratesFromAccumulated } = await metmod();
  const n = 6;
  // ECMWF, cada 3 h, en metros: 0, 3 mm, 9 mm y 9,6 mm en el primer punto.
  const ec = [3, 6, 9].map((h, k) => ({ h, acc: pickMet([temp2m(280), fake(193, 0, h, h, [[0.003, 0.009, 0.0096][k], 0, 0, 0, 0, 0])], 'ecmwf', FAKE_GRID, h, (m) => m.hour === h || m.cat === 0).acc }));
  assert.ok(Math.abs(ec[0].acc[0].values[0] - 3) < 1e-4, 'metros a mm');
  const r1 = ratesFromAccumulated([{ h: 0, acc: null }, ...ec], n);
  assert.deepEqual(r1.map((r) => [r.h, r.span]), [[0, 0], [3, 3], [6, 3], [9, 3]]);
  assert.deepEqual(r1.map((r) => +r.rate[0].toFixed(3)), [0, 1, 2, 0.2], 'mm/h de cada tramo de 3 h');
  assert.ok(r1.every((r) => r.rate.length === n));
  // ICON-EU, cada hora, en mm desde la pasada (a +0 h no hay fichero de lluvia). Con +2 h perdida: el tramo de +3 h dura 2 horas.
  const ic = (h, v) => ({ h, acc: pickMet([temp2m(280), fake(52, 0, h, h, [v, 0, 0, 0, 0, 0])], 'icon-eu', FAKE_GRID, h, (m) => m.hour === h || m.cat === 0).acc });
  const r2 = ratesFromAccumulated([{ h: 0, acc: null }, ic(1, 0.5), ic(3, 2.5), ic(4, 2.5)], n);
  assert.deepEqual(r2.map((r) => [r.h, r.span, +r.rate[0].toFixed(3)]), [[0, 0, 0], [1, 1, 0.5], [3, 2, 1], [4, 1, 0]]);
  // Sin +0 h y empezando en +2 h: el primer tramo va desde el principio de la pasada.
  const r3 = ratesFromAccumulated([ic(2, 1), ic(3, 1.5)], n);
  assert.deepEqual(r3.map((r) => [r.h, r.span, +r.rate[0].toFixed(3)]), [[2, 2, 0.5], [3, 1, 0.5]]);
  // El redondeo de dos acumulados casi iguales no da lluvia negativa.
  assert.equal(ratesFromAccumulated([ic(1, 1), ic(2, 0.99)], n)[1].rate[0], 0);
  // Un acumulado que falta en medio se salta.
  assert.deepEqual(ratesFromAccumulated([ic(1, 1), { h: 2, acc: undefined }, ic(3, 4)], n).map((r) => [r.h, r.span]), [[1, 1], [3, 2]]);
});

test('lluvia: GFS acumula en tramos de 6 h que vuelven a cero; con los mensajes reales se reconstruye igual con el acumulado o con los tramos', async () => {
  const { parseGrib2 } = await grib();
  const { pickMet, ratesFromAccumulated } = await metmod();
  const picks = {};
  for (const h of [6, 7, 12]) picks[h] = pickMet(parseGrib2(fs.readFileSync(RAIN(h))), 'gfs', RAIN_GRID, h, validAt(h));
  const n = 35;
  // Con el acumulado desde la pasada (lo que trae cada fichero de NOMADS).
  const whole = ratesFromAccumulated([6, 7, 12].map((h) => ({ h, acc: picks[h].acc })), n);
  assert.deepEqual(whole.map((r) => [r.h, r.span]), [[6, 6], [7, 1], [12, 5]]);
  // Solo con los tramos (6–7 y 6–12 de las horas siguientes): el de +6 h ya es el acumulado (0–6).
  const buckets = [6, 7, 12].map((h) => ({ h, acc: picks[h].acc.filter((a) => a.start === (h === 6 ? 0 : 6)) }));
  assert.deepEqual(buckets.map((b) => b.acc.length), [1, 1, 1]);
  const rebuilt = ratesFromAccumulated(buckets, n);
  assert.deepEqual(rebuilt.map((r) => [r.h, r.span]), [[6, 6], [7, 1], [12, 5]]);
  for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) assert.ok(Math.abs(rebuilt[k].rate[i] - whole[k].rate[i]) < 0.07, `+${rebuilt[k].h} h punto ${i}: ${rebuilt[k].rate[i]} frente a ${whole[k].rate[i]}`);
  // La media de +7 h es el tramo 6–7 tal cual lo da el modelo (1 hora).
  const bucket67 = picks[7].acc.find((a) => a.start === 6).values;
  for (let i = 0; i < n; i++) assert.ok(Math.abs(whole[1].rate[i] - bucket67[i]) < 0.13, `6–7 h punto ${i}`);
  // Lo que cae entre +7 y +12 h es el tramo 6–12 menos el 6–7.
  const bucket612 = picks[12].acc.find((a) => a.start === 6).values;
  for (let i = 0; i < n; i++) assert.ok(Math.abs(whole[2].rate[i] * 5 - (bucket612[i] - bucket67[i])) < 0.2, `7–12 h punto ${i}`);
  assert.ok(Math.max(...whole[0].rate) > 2, 'llueve de verdad en el recorte');
  // Si falta el acumulado del principio del tramo, el siguiente no se puede reconstruir.
  assert.deepEqual(ratesFromAccumulated([{ h: 7, acc: picks[7].acc.filter((a) => a.start === 6) }], n), []);
});

test('lluvia: el formato de lluvia y temperatura se codifica y decodifica (lluvia no lineal, temperatura de 0,5 °C)', () => {
  const grid = { west: 0, north: 10, step: 0.25, cols: 30, rows: 20 };
  const n = grid.cols * grid.rows;
  const rain = new Float32Array(n), temp = new Float32Array(n);
  for (let i = 0; i < n; i++) { rain[i] = i % 5 ? 0 : ((i % 97) / 96) ** 3 * 60; temp[i] = -20 + 70 * Math.abs(Math.sin(i / 41)); }
  rain[10] = 0.003; rain[15] = 0.04; rain[20] = 0.1; rain[25] = 0.3; rain[30] = 59.9; rain[35] = 500; rain[40] = -1; temp[5] = NaN; temp[6] = -90; temp[7] = 90;
  const bytes = M.encode({ rain, temp }, grid);
  assert.equal(bytes.length, 2 * n);
  const d = M.decode(bytes, grid);
  for (let i = 0; i < n; i++) {
    const r = rain[i] > 0 ? Math.min(rain[i], 104) : 0;
    // Resolución de 0,1 mm/h o mejor hasta 1,5 mm/h y relativa después (la mitad de un escalón).
    const tol = r < 1.5 ? 0.05 : Math.sqrt(r) * 0.04 + 0.01;
    assert.ok(Math.abs(d.rain[i] - r) <= tol, `lluvia[${i}] ${rain[i]} → ${d.rain[i]}`);
    if (i > 7) assert.ok(Math.abs(d.temp[i] - temp[i]) <= 0.25 + 1e-4, `temperatura[${i}]`);
  }
  assert.ok(d.rain[30] > 59 && d.rain[30] < 61, 'más de 60 mm/h se distinguen');
  assert.ok(Math.abs(d.rain[35] - 104.04) < 1e-3, 'se recorta a 104 mm/h');
  assert.equal(d.rain[40], 0, 'la lluvia negativa es 0');
  assert.equal(d.temp[6], -60, 'se recorta a −60 °C');
  assert.equal(d.temp[7], 60, 'y a +60 °C');
  assert.equal(d.temp[5], d.temp[4], 'sin dato, la del punto anterior');
  assert.equal(new Set(M.decode(M.encode({ rain: new Float32Array(n), temp: new Float32Array(n).fill(14.9) }, grid), grid).temp).size, 1);
  // Va aparte del viento: la misma rejilla, con 2 campos en vez de 3.
  assert.equal(M.encode({ rain, temp }, grid).length / n, 2);
  assert.throws(() => M.decode(bytes.subarray(1), grid), /bytes/);
  // El campo de lluvia, casi todo ceros, comprime muy bien.
  assert.ok(zlib.gzipSync(M.encode({ rain: new Float32Array(n), temp }, grid)).length < n);
  // Interpolación en un punto y fuera de la rejilla.
  const g = { west: -10, north: 50, step: 1, cols: 3, rows: 3 };
  const step = { rain: Float32Array.from([0, 2, 4, 0, 2, 4, 0, 2, 4]), temp: Float32Array.from([10, 12, 14, 10, 12, 14, 10, 12, 14]) };
  const s = M.sample(step, g, 49.5, -9.5);
  assert.ok(Math.abs(s.rain - 1) < 1e-6 && Math.abs(s.temp - 11) < 1e-6);
  assert.equal(M.sample(step, g, 51, -9), null);
});

test('lluvia: los colores de la lluvia son los del radar y la temperatura tiene su escala divergente', () => {
  const lut = M.rainColorTable();
  assert.equal(lut.length, 256);
  assert.equal(lut[0], 0, 'sin lluvia, transparente');
  for (let q = 1; q < 256; q++) assert.equal(lut[q] === 0, (q / M.META.rainK) ** 2 < M.RAIN_MIN, `q = ${q}`);
  // Misma intensidad, mismo color que el radar (tabla de palette.js, por dBZ).
  const pack = ([r, g, b, a]) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const radar = (dbz) => P._table.find((e) => e.kind === P.KIND_RAIN && e.dbz === dbz).rgba;
  for (const mm of [0.3, 1, 5, 20, 60]) {
    const q = M.rainIndex(mm), rate = (q / M.META.rainK) ** 2;
    assert.equal(lut[q], pack(radar(Math.floor(P.rateToDbz(rate, P.KIND_RAIN)))), `${mm} mm/h`);
  }
  assert.equal(M.rainIndex(0), 0);
  assert.equal(M.rainIndex(1e6), 255);
  assert.ok(Math.abs(P.rateToDbz(M.RAIN_MIN, P.KIND_RAIN) - 7) < 0.05, '0,1 mm/h son los 7 dBZ que el radar no pinta por debajo');
  assert.equal(M.rainCss(5), P.cssFor(P.rateToDbz(5, P.KIND_RAIN), P.KIND_RAIN));
  // Temperatura: del azul violeta al rojo oscuro, con un neutro entre medias.
  const t = M.tempColorTable();
  assert.equal(t.length, M.TEMP_Q_MAX + 1);
  assert.deepEqual(M.tempColor(-60), M.TEMP_ANCHORS[0][1]);
  assert.deepEqual(M.tempColor(80), M.TEMP_ANCHORS[M.TEMP_ANCHORS.length - 1][1]);
  const [cr, cg, cb] = M.tempColor(-10), [wr, wg, wb] = M.tempColor(35);
  assert.ok(cb > cr && wr > wb, 'frío azulado, calor rojizo');
  const mid = M.tempColor(15);
  assert.ok(Math.max(...mid) - Math.min(...mid) < 40, 'a los 15 °C el color es casi neutro');
  assert.equal(t[M.tempIndex(20)], ((255 << 24) | (M.tempColor(20)[2] << 16) | (M.tempColor(20)[1] << 8) | M.tempColor(20)[0]) >>> 0);
  assert.equal(M.tempIndex(-60), 0);
  assert.equal(M.tempIndex(0.2), 120);
  assert.equal(M.tempIndex(100), M.TEMP_Q_MAX);
  assert.ok(wg !== undefined && cg !== undefined);
});
