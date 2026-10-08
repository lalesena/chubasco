// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const TIFF = require('../src/main/tiff');
const O = require('../src/main/opera');
const { operaFile } = require('../src/main/mock-opera');

// Un chubasco rectangular de 40 dBZ cerca de Madrid.
const STORM = { lat0: 40, lat1: 40.5, lon0: -3.9, lon1: -3.5 };
const file = operaFile((lat, lon) => (lat > STORM.lat0 && lat < STORM.lat1 && lon > STORM.lon0 && lon < STORM.lon1 ? 40 : NaN),
  { lat0: 39, lat1: 42, lon0: -5, lon1: -2 });

function fakeFetch({ latest = Infinity, log = [] } = {}) {
  return async (url, opts) => {
    log.push(url);
    const m = /OPERA@(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})@/.exec(url);
    const time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
    if (time > latest) return new Response('', { status: 404 });
    const r = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
    return new Response(file.read(+r[1], +r[2]), { status: 206 });
  };
}

test('LAEA: ejemplo de EPSG (ETRS89-LAEA) e inversa', () => {
  const p = O.laea({ lat0: 52, lon0: 10, falseEasting: 4321000, falseNorthing: 3210000, invFlattening: 298.257222101 });
  const f = p.forward(50, 5);
  assert.ok(Math.abs(f.e - 3962799.45) < 0.01 && Math.abs(f.n - 2999718.85) < 0.01, JSON.stringify(f));
  for (const [lat, lon] of [[40.4, -3.7], [64, 25], [36, 30], [55, 10]]) {
    const q = p.forward(lat, lon);
    const b = p.inverse(q.e, q.n);
    assert.ok(Math.abs(b.lat - lat) < 1e-7 && Math.abs(b.lon - lon) < 1e-7);
  }
});

test('TIFF: cabecera por trozos y mosaico DEFLATE con dos muestras', async () => {
  assert.throws(() => TIFF.parseHeader(file.read(0, 255)), TIFF.NeedMore);
  const h = TIFF.parseHeader(file.read(0, 16383));
  assert.deepEqual(h.ifds.map((i) => i.width), [3800, 1900, 950, 475, 237]);
  assert.equal(h.ifds[0].nodata, -9999000);
  assert.deepEqual(h.geo.laea, { lat0: 55, lon0: 10, falseEasting: 1950000, falseNorthing: -2100000, a: 6378137, invFlattening: 298.257223563 });
  assert.equal(h.geo.originX, -500);

  // Como el OPERA real: dBZ y calidad intercalados, comprimidos.
  const vals = new Float32Array([12.5, 0.9, NaN, 0.1, -9999000, 0, 47, 1]);
  const ifd = { bits: 32, sampleFormat: 3, planar: 1, predictor: 1, compression: 8, tileWidth: 2, tileHeight: 2, samples: 2 };
  const out = await TIFF.decodeTile(ifd, zlib.deflateSync(Buffer.from(vals.buffer)));
  assert.equal(out[0], 12.5); assert.ok(Number.isNaN(out[1])); assert.equal(out[2], -9999000); assert.equal(out[3], 47);
});

test('OPERA: códigos de un byte', () => {
  assert.equal(O.encode(NaN, -9999000), O.NONE);
  assert.equal(O.encode(-9999000, -9999000), O.NODATA);
  assert.equal(O.dbzOf(O.encode(35.5, -9999000)), 35.5);
  assert.equal(O.encode(-40, -9999000), 1);
  assert.equal(O.encode(200, -9999000), 254);
});

test('OPERA: fotogramas desde el último publicado', async () => {
  const now = Math.floor(Date.now() / 1000);
  const latest = Math.floor((now - 300) / 300) * 300 - 300; // dos pasos de retraso
  const op = new O.OperaSource({ fetch: fakeFetch({ latest }) });
  const maps = await op.getMaps();
  assert.equal(maps.source, 'opera');
  assert.equal(maps.frames[maps.frames.length - 1].time, latest);
  assert.equal(maps.frames.length, latest % 600 ? 14 : 13);
  assert.equal(maps.frames[0].time, Math.floor(latest / 600) * 600 - 7200);
  assert.ok(O.fileUrl(O.BASE_URL, 1791363000).endsWith('/2026/10/07/OPERA/COMP/OPERA@20261007T0850@0@DBZH.tiff'));
});

test('OPERA: análisis de una ubicación y sin cobertura fuera de Europa', async () => {
  const log = [];
  const op = new O.OperaSource({ fetch: fakeFetch({ log }) });
  op.latest = 1e9;
  const opts = { thresholdDbz: 18, alarmRadiusKm: 20 };
  const inside = await op.analyze({ id: 'a', name: 'Dentro', lat: 40.25, lon: -3.7 }, opts);
  assert.equal(inside.source, 'opera');
  assert.equal(inside.atLocation.dbz, 40);
  assert.equal(inside.missingFraction, 0);
  // Toledo: el chubasco empieza ~19 km al nordeste.
  const near = await op.analyze({ id: 'b', name: 'Toledo', lat: 39.86, lon: -4.02 }, opts);
  assert.ok(Math.abs(near.nearestAny.distanceKm - 18.9) < 1.5, near.nearestAny.distanceKm);
  assert.ok(Math.abs(near.nearestAny.bearingDeg - 33) < 6, near.nearestAny.bearingDeg);

  const before = log.length;
  await assert.rejects(op.analyze({ id: 'c', name: 'Nueva York', lat: 40.7, lon: -74 }, opts), (e) => e.code === 'noCoverage');
  assert.equal(log.length, before, 'fuera de la rejilla no se descarga nada');
});

test('OPERA: teselas del mapa en su sitio', async () => {
  const op = new O.OperaSource({ fetch: fakeFetch() });
  const z = 8, x = 125, y = 96, size = 256;
  const q = await op.viewTile({ time: 1e9, z, x, y, size, smooth: true });
  let x0 = size, x1 = -1, y0 = size, y1 = -1;
  q.forEach((v, i) => {
    if (v === O.NONE || v === O.NODATA || O.dbzOf(v) < 30) return;
    const px = i % size, py = (i - px) / size;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  });
  const W = size * 2 ** z;
  const lon = (px) => ((x * size + px) / W) * 360 - 180;
  const lat = (py) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * size + py)) / W))) * 180) / Math.PI;
  const tol = 0.02; // ~1 píxel de OPERA
  assert.ok(Math.abs(lon(x0) - STORM.lon0) < tol && Math.abs(lon(x1 + 1) - STORM.lon1) < tol, `${lon(x0)} ${lon(x1 + 1)}`);
  assert.ok(Math.abs(lat(y1 + 1) - STORM.lat0) < tol && Math.abs(lat(y0) - STORM.lat1) < tol, `${lat(y1 + 1)} ${lat(y0)}`);
  // Lejos de Europa: todo "sin datos" y sin descargar mosaicos.
  const far = await op.viewTile({ time: 1e9, z: 3, x: 2, y: 3 });
  assert.ok(far.every((v) => v === O.NODATA));
});

test('Intermediario de Cloudflare: solo OPERA, con rango, CORS para la web propia y caché', async () => {
  const worker = (await import(pathToFileURL(path.join(__dirname, '../proxy/opera-worker.js')).href)).default;
  const store = new Map();
  globalThis.caches = { default: {
    async match(req) { const e = store.get(req.url); return e && new Response(e.body, e.init); },
    async put(req, res) {
      assert.notEqual(res.status, 206);
      store.set(req.url, { body: await res.arrayBuffer(), init: { status: res.status, headers: Object.fromEntries(res.headers) } });
    }
  } };
  const realFetch = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async (url, opts) => {
    upstream++;
    assert.ok(url.startsWith(O.BASE_URL + '/2026/10/07/OPERA/COMP/'));
    const r = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
    return new Response(file.read(+r[1], +r[2]), { status: 206, headers: { 'Content-Range': `bytes ${r[1]}-${r[2]}/${file.size}` } });
  };
  try {
    const WEB = 'https://lalesena.github.io';
    const call = async (p, range, method = 'GET', origin = WEB, env = {}) => {
      const waits = [];
      const headers = {};
      if (range) headers.Range = range;
      if (origin) headers.Origin = origin;
      const res = await worker.fetch(new Request('https://proxy.example' + p, { method, headers }), env, { waitUntil: (w) => waits.push(w) });
      await Promise.all(waits);
      return res;
    };
    const good = '/2026/10/07/OPERA/COMP/OPERA@20261007T0850@0@DBZH.tiff';
    const a = await call(good, 'bytes=0-16383');
    assert.equal(a.status, 206);
    assert.equal(a.headers.get('access-control-allow-origin'), WEB);
    assert.equal(a.headers.get('content-range'), `bytes 0-16383/${file.size}`);
    assert.deepEqual(new Uint8Array(await a.arrayBuffer()), file.read(0, 16383));
    const b = await call(good, 'bytes=0-16383');
    assert.equal(b.status, 206);
    assert.equal(upstream, 1, 'el segundo trozo sale de la caché');
    assert.equal((await call(good, null)).status, 416);
    assert.equal((await call(good, 'bytes=0-99999999')).status, 416);
    assert.equal((await call('/2026/10/07/OPERA/COMP/OPERA@20261008T0850@0@DBZH.tiff', 'bytes=0-9')).status, 404);
    assert.equal((await call('/etc/passwd', 'bytes=0-9')).status, 404);
    assert.equal((await call(good, null, 'OPTIONS')).status, 204);
    // Otras webs (o copias del repositorio) no pueden usarlo; sin Origin, tampoco.
    const other = await call(good, 'bytes=0-16383', 'GET', 'https://otra.example');
    assert.equal(other.status, 403);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    assert.equal((await call(good, 'bytes=0-16383', 'GET', null)).status, 403);
    assert.equal((await call(good, 'bytes=0-16383', 'GET', 'http://localhost:8080')).status, 206, 'pruebas en local');
    assert.equal((await call(good, 'bytes=0-16383', 'GET', 'https://otra.example', { ALLOWED_ORIGINS: 'https://otra.example, https://x.example' })).status, 206, 'lista propia de cada despliegue');
    assert.equal(upstream, 1);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.caches;
  }
});

test('los ajustes de la fuente de radar anterior se borran al cargar', () => {
  const { StoreCore } = require('../src/main/store');
  const s = new StoreCore({ settings: { radarSource: 'rainviewer', showSnow: false, smooth: false } });
  assert.ok(!('radarSource' in s.settings) && !('showSnow' in s.settings));
  assert.equal(s.settings.smooth, false);
});
