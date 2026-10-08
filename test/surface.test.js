'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { idwGrid } = require('../src/renderer/surface');

const CELL = 4;
// Centro de la celda (c, r) en píxeles.
const centre = (c, r) => [(c + 0.5) * CELL, (r + 0.5) * CELL];
const grid = (points, extra = {}) => idwGrid({ points, cols: 60, rows: 40, cell: CELL, radius: 60, ...extra });
const at = (g, c, r, cols = 60) => g[r * cols + c];

test('superficie: la celda con un punto toma su valor exacto', () => {
  const [x, y] = centre(20, 10);
  // Un poco desplazado del centro (dentro de media celda) y con otros puntos cerca.
  const g = grid([[x + 1.5, y - 1, 7.5], [x + 30, y, 100], [x, y + 30, -50]]);
  assert.equal(at(g, 20, 10), 7.5);
  assert.notEqual(at(g, 21, 10), 7.5);
});

test('superficie: a medio camino entre dos puntos sale la media', () => {
  const a = centre(10, 20), b = centre(20, 20);
  const g = grid([[a[0], a[1], 0], [b[0], b[1], 10]]);
  assert.ok(Math.abs(at(g, 15, 20) - 5) < 1e-4, `salió ${at(g, 15, 20)}`);
  // Más cerca de uno, más parecido a él.
  assert.ok(at(g, 12, 20) < 5 && at(g, 18, 20) > 5);
});

test('superficie: entre los puntos el valor queda dentro de [mín, máx]', () => {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = [];
  for (let i = 0; i < 60; i++) pts.push([rnd() * 240, rnd() * 160, 2 + rnd() * 18]);
  const min = Math.min(...pts.map((p) => p[2])), max = Math.max(...pts.map((p) => p[2]));
  const g = grid(pts);
  let finite = 0;
  for (const v of g) {
    if (Number.isNaN(v)) continue;
    finite++;
    assert.ok(v >= min - 1e-4 && v <= max + 1e-4, `${v} fuera de [${min}, ${max}]`);
  }
  assert.ok(finite > g.length / 2);
});

test('superficie: más allá del radio de todos los puntos no hay valor', () => {
  const p = centre(5, 5); // esquina superior izquierda
  const radius = 40; // 10 celdas
  const g = grid([[p[0], p[1], 3]], { radius });
  assert.equal(at(g, 5, 5), 3);
  assert.ok(Number.isFinite(at(g, 5 + 8, 5)), 'a 8 celdas (32 px) entra');
  assert.ok(Number.isNaN(at(g, 5 + 11, 5)), 'a 11 celdas (44 px) no');
  assert.ok(Number.isNaN(at(g, 55, 35)), 'en la otra esquina tampoco');
  // Sin puntos, todo NaN.
  assert.ok(grid([]).every(Number.isNaN));
});

test('superficie: los puntos algo fuera del borde siguen contando; los muy lejanos, no', () => {
  const g = grid([[-20, 80, 9]], { radius: 60 }); // 20 px a la izquierda de la rejilla
  assert.ok(Number.isFinite(at(g, 0, 20)));
  assert.ok(Number.isNaN(at(g, 20, 20)));
  const far = grid([[-500, 80, 9], [5000, 80, 9]], { radius: 60 });
  assert.ok(far.every(Number.isNaN));
  // Los valores o coordenadas que no son números se ignoran.
  const bad = grid([[10, 10, NaN], [NaN, 10, 5], [30, 30, 4]]);
  assert.equal(at(bad, 7, 7), 4);
});

test('superficie: solo cuentan los k puntos más cercanos', () => {
  const [x, y] = centre(30, 20);
  const near = [];
  // 3 puntos cercanos (a 20-28 px) con valor 1 y un racimo lejano (a 80 px) con valor 100.
  for (const [dx, dy] of [[20, 0], [-24, 0], [0, 28]]) near.push([x + dx, y + dy, 1]);
  const far = [];
  for (let i = 0; i < 20; i++) far.push([x + 80 + (i % 5), y + (i >> 2) * 2, 100]);
  const opts = { radius: 100 };
  const g3 = grid([...near, ...far], { ...opts, k: 3 });
  assert.ok(Math.abs(at(g3, 30, 20) - 1) < 1e-6, `con k=3 salió ${at(g3, 30, 20)}`);
  const g30 = grid([...near, ...far], { ...opts, k: 30 });
  assert.ok(at(g30, 30, 20) > 1.5, `con k=30 debería notarse el racimo: ${at(g30, 30, 20)}`);
});

test('superficie: la potencia pesa más a los cercanos', () => {
  const a = centre(10, 20), b = centre(30, 20);
  const pts = [[a[0], a[1], 0], [b[0], b[1], 10]];
  const p1 = at(grid(pts, { power: 1 }), 15, 20);
  const p2 = at(grid(pts, { power: 2 }), 15, 20);
  const p4 = at(grid(pts, { power: 4 }), 15, 20);
  assert.ok(p1 > p2 && p2 > p4 && p4 > 0, `${p1} ${p2} ${p4}`);
});

test('superficie: 350×225 celdas y 800 puntos, rápido', () => {
  let s = 987654321;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = [];
  for (let i = 0; i < 800; i++) pts.push([rnd() * 1400, rnd() * 900, rnd() * 40]);
  const run = () => idwGrid({ points: pts, cols: 350, rows: 225, cell: 4, radius: 60 });
  run(); // calentar
  const t0 = process.hrtime.bigint();
  const g = run();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# idwGrid 350x225, 800 puntos, radio 60: ${ms.toFixed(1)} ms`);
  assert.equal(g.length, 350 * 225);
  assert.ok(g.filter(Number.isFinite).length > g.length * 0.9);
  assert.ok(ms < 400, `${ms.toFixed(1)} ms`);
});
