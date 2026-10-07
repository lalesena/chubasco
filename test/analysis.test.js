'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/main/analysis');
const P = require('../src/shared/palette');

const RAIN30 = [0x00, 0x55, 0x88, 0xff];  // 30 dBZ, Universal Blue
const RAIN40 = [0xff, 0xaa, 0x00, 0xff];  // 40 dBZ
const SNOW20 = [0x7f, 0xbf, 0xff, 0xff];  // nieve 20 dBZ

// Genera tiles sintéticos: blobs circulares (centro en px globales, radio px).
function makeTiles(box, blobs) {
  const map = new Map();
  for (const t of box.tiles) {
    const data = Buffer.alloc(A.TILE_SIZE * A.TILE_SIZE * 4);
    for (let y = 0; y < A.TILE_SIZE; y++) {
      for (let x = 0; x < A.TILE_SIZE; x++) {
        const gx = t.txRaw * A.TILE_SIZE + x, gy = t.ty * A.TILE_SIZE + y;
        for (const b of blobs) {
          const d = Math.hypot(gx - b.x, gy - b.y);
          if (d <= b.r) {
            const c = b.core && d <= b.r * 0.4 ? b.core : b.color;
            const o = (y * A.TILE_SIZE + x) * 4;
            data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c[3];
          }
        }
      }
    }
    map.set(`${t.tx}/${t.ty}`, { width: A.TILE_SIZE, height: A.TILE_SIZE, data });
  }
  return (t) => map.get(`${t.tx}/${t.ty}`);
}

const MADRID = { lat: 40.4168, lon: -3.7038 };

test('paleta: colores exactos se clasifican bien', () => {
  assert.deepStrictEqual(P.classifyRGBA(...RAIN30), { dbz: 30, kind: P.KIND_RAIN });
  assert.deepStrictEqual(P.classifyRGBA(...RAIN40), { dbz: 40, kind: P.KIND_RAIN });
  assert.deepStrictEqual(P.classifyRGBA(...SNOW20), { dbz: 20, kind: P.KIND_SNOW });
  assert.strictEqual(P.classifyRGBA(0, 0, 0, 0).kind, P.KIND_NONE);
  // Marshall-Palmer: 30 dBZ ≈ 2,7 mm/h
  assert.ok(Math.abs(P.dbzToRate(30, P.KIND_RAIN) - 2.73) < 0.05);
});

test('proyección ida y vuelta', () => {
  const p = A.project(MADRID.lat, MADRID.lon);
  const q = A.unproject(p.x, p.y);
  assert.ok(Math.abs(q.lat - MADRID.lat) < 1e-6 && Math.abs(q.lon - MADRID.lon) < 1e-6);
});

test('lluvia al oeste que se mueve hacia el este: distancia, rumbo, velocidad y ETA', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 120);
  const mpp = box.mpp;
  const kmPx = 1000 / mpp;
  const c = A.project(MADRID.lat, MADRID.lon);
  const speedKmh = 30;
  const grids = [];
  for (let k = 0; k < 4; k++) {
    // Frame k: blob centrado 40 km al oeste en el último fotograma (k=3).
    const offsetKm = -40 - (3 - k) * (speedKmh / 6);
    const blobs = [
      { x: c.x + offsetKm * kmPx, y: c.y + 3 * kmPx, r: 15 * kmPx, color: RAIN30, core: RAIN40 },
      // Otro eco lejano al sur para dar textura (se mueve igual).
      { x: c.x + (offsetKm + 10) * kmPx, y: c.y + 70 * kmPx, r: 8 * kmPx, color: RAIN30 }
    ];
    const g = A.buildGrid(box, makeTiles(box, blobs));
    g.time = 1000 + k * 600;
    grids.push(g);
  }
  const stats = A.locationStats(grids[3], box, { alarmRadiusKm: 30, thresholdDbz: 18 });
  assert.ok(stats.nearest, 'debe haber eco en el radio');
  assert.ok(Math.abs(stats.nearest.distanceKm - 25.3) < 1.5, `distancia ${stats.nearest.distanceKm}`);
  assert.ok(Math.abs(stats.nearest.bearingDeg - 270) < 15, `rumbo ${stats.nearest.bearingDeg}`);
  assert.strictEqual(stats.atLocation.dbz, null);

  const pairs = [];
  for (let i = 1; i < 4; i++) pairs.push(A.estimateMotion(grids[i - 1], grids[i], box, 10));
  const m = A.combineMotion(pairs, box);
  assert.ok(m, 'movimiento detectado');
  assert.ok(Math.abs(m.speedKmh - speedKmh) < 4, `velocidad ${m.speedKmh}`);
  assert.ok(Math.abs(m.headingDeg - 90) < 8, `rumbo movimiento ${m.headingDeg}`);
  assert.ok(m.confidence > 0.4, `confianza ${m.confidence}`);

  const nc = A.nowcast(grids[3], box, m, { thresholdDbz: 18 });
  // 25 km a 30 km/h ≈ 50 min (±10)
  assert.ok(nc.etaMin >= 40 && nc.etaMin <= 60, `eta ${nc.etaMin}`);
  // Tras pasar el blob (30 km de diámetro a 30 km/h ≈ 60 min) debe secarse.
  const wet = nc.series.filter((s) => s.dbz !== null && s.dbz >= 18).map((s) => s.t);
  assert.ok(wet.length > 6 && wet[wet.length - 1] <= 120);
});

test('lloviendo en la ubicación: nowcast con fin estimado', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 100);
  const kmPx = 1000 / box.mpp;
  const c = A.project(MADRID.lat, MADRID.lon);
  const grids = [];
  for (let k = 0; k < 3; k++) {
    // Blob de 10 km de radio moviéndose al norte a 24 km/h (4 km cada 10 min),
    // centrado 4 km al norte de la ubicación en el último fotograma.
    const northKm = 4 - (2 - k) * 4;
    const g = A.buildGrid(box, makeTiles(box, [
      { x: c.x, y: c.y - northKm * kmPx, r: 10 * kmPx, color: RAIN30 },
      { x: c.x + 50 * kmPx, y: c.y + (30 - northKm) * kmPx, r: 6 * kmPx, color: RAIN30 }
    ]));
    g.time = k * 600;
    grids.push(g);
  }
  const stats = A.locationStats(grids[2], box, { alarmRadiusKm: 25, thresholdDbz: 18 });
  assert.strictEqual(stats.atLocation.dbz, 30);
  const m = A.combineMotion([A.estimateMotion(grids[0], grids[1], box, 10), A.estimateMotion(grids[1], grids[2], box, 10)], box);
  assert.ok(m, 'movimiento');
  assert.ok(Math.min(m.headingDeg, 360 - m.headingDeg) < 12, `rumbo ${m.headingDeg}`);
  assert.ok(Math.abs(m.speedKmh - 24) < 4, `velocidad ${m.speedKmh}`);
  const nc = A.nowcast(grids[2], box, m, { thresholdDbz: 18 });
  assert.strictEqual(nc.etaMin, 0);
  // El borde sur está a 6 km; a 24 km/h ≈ 15 min.
  assert.ok(nc.endMin !== null && nc.endMin >= 10 && nc.endMin <= 25, `fin ${nc.endMin}`);
});

test('sin ecos: sin movimiento ni ETA', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 90);
  const g = A.buildGrid(box, makeTiles(box, []));
  assert.strictEqual(A.estimateMotion(g, g, box, 10), null);
  const nc = A.nowcast(g, box, null, { thresholdDbz: 18 });
  assert.strictEqual(nc.etaMin, null);
  const s = A.locationStats(g, box, { alarmRadiusKm: 25, thresholdDbz: 18 });
  assert.strictEqual(s.nearest, null);
});

test('tile que falla se marca como sin datos', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 90);
  const g = A.buildGrid(box, () => null);
  assert.strictEqual(g.missingFraction, 1);
});
