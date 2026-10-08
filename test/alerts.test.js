// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, freshState, inQuietHours } = require('../src/main/alerts');
const I18N = require('../src/shared/i18n');
const D = require('../src/shared/describe');
const { DEFAULT_ALARM } = require('../src/main/store');

const t = I18N.make('es');
const settings = { units: { rate: 'mm', distance: 'km' } };
const loc = { id: 'a', name: 'Casa', lat: 40, lon: -3, alarm: { ...DEFAULT_ALARM } };
const MIN = 60000;

function radar({ at = null, near = null, eta = null, end = null, frameAgoMin = 0, now }) {
  return {
    ok: true,
    frameTime: (now - frameAgoMin * MIN) / 1000,
    atLocation: { dbz: at, kind: 1, rate: at ? 3 : null, hasData: true },
    nearest: near ? { distanceKm: near, bearingDeg: 270, dbz: 30, kind: 1, rate: 2.7 } : null,
    motion: { speedKmh: 30, headingDeg: 90, confidence: 0.9 },
    nowcast: { etaMin: at ? 0 : eta, endMin: end, series: [] },
    approaching: !!eta
  };
}

function run(steps) {
  let state = freshState();
  const out = [];
  for (const s of steps) {
    const res = evaluate({ loc, status: { radar: radar({ ...s, now: s.now }) }, state, now: s.now, settings, t });
    state = res.state;
    out.push(...res.alerts.map((a) => ({ at: s.now, ...a })));
  }
  return out;
}

test('secuencia típica: radio → inminente → llueve → termina, sin repeticiones', () => {
  const T0 = Date.UTC(2026, 9, 6, 12);
  const steps = [];
  // 0-10 min: nada; 15: eco a 20 km (ETA 50); 20-35: se acerca (ETA 25..10);
  // 40-70: llueve; 75-85: seco.
  for (let m = 0; m <= 85; m += 5) {
    const now = T0 + m * MIN;
    if (m < 15) steps.push({ now });
    else if (m < 20) steps.push({ now, near: 20, eta: 50 });
    else if (m < 40) steps.push({ now, near: 20 - (m - 15), eta: 40 - m + 5 });
    else if (m < 75) steps.push({ now, at: 30, near: 0.5, end: 75 - m });
    else steps.push({ now });
  }
  const alerts = run(steps);
  const types = alerts.map((a) => a.type);
  assert.deepStrictEqual(types, ['inRadius', 'imminent', 'atLocation', 'ended']);
  assert.match(alerts[0].title, /Lluvia a 20 km de Casa/);
  assert.match(alerts[1].title, /Lluvia en ~\d+ min en Casa/);
  assert.match(alerts[2].body, /Fin estimado/);
});

test('la ETA descuenta la antigüedad del fotograma', () => {
  const now = Date.now();
  const r = radar({ near: 20, eta: 40, frameAgoMin: 12, now });
  assert.strictEqual(D.etaFromNow(r, now), 28);
  const d = D.describe({ radar: r }, loc, settings, t);
  assert.strictEqual(d.level, 'imminent');
  assert.strictEqual(d.headline, 'Lluvia en ~30 min'); // redondeo a 5 min
});

test('alarma desactivada no avisa', () => {
  const now = Date.now();
  const off = { ...loc, alarm: { ...loc.alarm, enabled: false } };
  const res = evaluate({ loc: off, status: { radar: radar({ at: 40, now }) }, state: freshState(), now, settings, t });
  assert.strictEqual(res.alerts.length, 0);
});

test('horas de silencio que cruzan la medianoche', () => {
  const q = { enabled: true, start: '23:00', end: '07:00' };
  const d = (h, m) => { const x = new Date(2026, 9, 6, h, m); return x; };
  assert.strictEqual(inQuietHours(q, d(23, 30)), true);
  assert.strictEqual(inQuietHours(q, d(3, 0)), true);
  assert.strictEqual(inQuietHours(q, d(7, 0)), false);
  assert.strictEqual(inQuietHours(q, d(12, 0)), false);
});

test('describe en inglés y en millas', () => {
  const now = Date.now();
  const te = I18N.make('en');
  const d = D.describe({ radar: radar({ near: 16, now }) }, loc, { units: { rate: 'in', distance: 'mi' } }, te);
  assert.strictEqual(d.headline, 'Rain 9.9 mi away');
});

test('chubascos intermitentes: sin ráfaga de "ha dejado de llover"', () => {
  const T0 = Date.UTC(2026, 9, 6, 12);
  const steps = [];
  // 3 h de ciclos de 15 min mojado / 15 min seco, comprobando cada 5 min.
  for (let m = 0; m <= 180; m += 5) {
    const wet = Math.floor(m / 15) % 2 === 0;
    steps.push(wet ? { now: T0 + m * MIN, at: 30, near: 0.5 } : { now: T0 + m * MIN, near: 6 });
  }
  const types = run(steps).map((a) => a.type);
  const ended = types.filter((x) => x === 'ended').length;
  const started = types.filter((x) => x === 'atLocation').length;
  assert.ok(ended <= started, `ended ${ended} > started ${started}`);
  assert.ok(ended <= 3, `demasiados avisos de fin: ${ended}`);
});

test('dos comprobaciones sobre el mismo fotograma no cuentan como dos fotogramas secos', () => {
  const T0 = Date.UTC(2026, 9, 6, 12);
  let state = freshState();
  const ev = (now, opts, frameTime) => {
    const r = radar({ ...opts, now });
    r.frameTime = frameTime / 1000;
    const res = evaluate({ loc, status: { radar: r }, state, now, settings, t });
    state = res.state;
    return res.alerts.map((a) => a.type);
  };
  ev(T0, { at: 30 }, T0);
  ev(T0 + 10 * MIN, { at: 30 }, T0 + 10 * MIN);
  ev(T0 + 20 * MIN, {}, T0 + 20 * MIN);
  // Misma imagen otra vez (p. ej. al despertar el equipo): no debe cerrar el episodio.
  assert.deepStrictEqual(ev(T0 + 20 * MIN + 5000, {}, T0 + 20 * MIN), []);
  assert.deepStrictEqual(ev(T0 + 30 * MIN, {}, T0 + 30 * MIN), ['ended']);
});

test('con fotogramas cada 5 min (OPERA), "ha parado" sigue pidiendo 10 min secos', () => {
  const T0 = Date.UTC(2026, 9, 6, 12);
  let state = freshState();
  const ev = (min, opts) => {
    const now = T0 + min * MIN;
    const res = evaluate({ loc, status: { radar: radar({ ...opts, now }) }, state, now, settings, t });
    state = res.state;
    return res.alerts.map((a) => a.type);
  };
  ev(0, { at: 30 });
  ev(5, { at: 30 });
  ev(10, { at: 30 });
  assert.deepStrictEqual(ev(15, {}), []);
  assert.deepStrictEqual(ev(20, {}), [], 'dos fotogramas secos en 5 min no bastan');
  assert.deepStrictEqual(ev(25, {}), ['ended']);
});

test('tras horas sin comprobar (suspensión) no llega un "ha dejado de llover" tardío', () => {
  const T0 = Date.UTC(2026, 9, 6, 12);
  const types = run([
    { now: T0, at: 30 },
    { now: T0 + 10 * MIN, at: 30 },
    { now: T0 + 600 * MIN },
    { now: T0 + 605 * MIN },
    { now: T0 + 615 * MIN }
  ]).map((a) => a.type);
  assert.deepStrictEqual(types, ['atLocation']);
});

test('radar desactualizado: sin avisos de radar', () => {
  const now = Date.now();
  const res = evaluate({ loc, status: { radar: radar({ near: 10, eta: 50, frameAgoMin: 45, now }) }, state: freshState(), now, settings, t });
  assert.strictEqual(res.alerts.length, 0);
  const d = D.describe({ radar: radar({ near: 10, eta: 50, frameAgoMin: 45, now }) }, loc, settings, t);
  assert.strictEqual(d.headline, 'Radar desactualizado');
});
