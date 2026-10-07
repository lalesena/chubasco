'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/main/analysis');
const P = require('../src/shared/palette');
const F = require('../src/shared/forecast');
const D = require('../src/shared/describe');
const I18N = require('../src/shared/i18n');
const { ClutterMap } = require('../src/main/clutter');
const { Verifier } = require('../src/main/verify');
const { evaluate, freshState } = require('../src/main/alerts');
const { Monitor } = require('../src/main/monitor');
const { DEFAULT_ALARM } = require('../src/main/store');

const MIN = 60000;
const t = I18N.make('es');
const MADRID = { lat: 40.4168, lon: -3.7038 };

// Rejilla sintética directamente en dBZ: blobs { x, y (px de la caja), r (px), dbz }.
function gridOf(box, blobs, time = 0) {
  const n = box.w * box.h;
  const dbz = new Float32Array(n).fill(NaN);
  const kind = new Uint8Array(n);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      for (const b of blobs) {
        if (Math.hypot(x - b.x, y - b.y) <= b.r) {
          const i = y * box.w + x;
          if (!(dbz[i] >= b.dbz)) { dbz[i] = b.dbz; kind[i] = P.KIND_RAIN; }
        }
      }
    }
  }
  return { w: box.w, h: box.h, dbz, kind, missingFraction: 0, time };
}

test('limpieza: una mota suelta no cuenta como lluvia; una mancha real sí', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 90);
  const kmPx = 1000 / box.mpp;
  const g = gridOf(box, [
    { x: Math.round(box.cx + 10 * kmPx), y: Math.round(box.cy), r: 0.5, dbz: 35 }, // 1 píxel a 10 km
    { x: box.cx - 40 * kmPx, y: box.cy, r: 6 * kmPx, dbz: 30 }  // chubasco a ~34 km
  ]);
  const raw = A.locationStats(g, box, { alarmRadiusKm: 50, thresholdDbz: 18 });
  assert.ok(raw.nearest.distanceKm < 11, 'sin limpiar, la mota es lo más cercano');
  const clean = A.cleanGrid(g, { thresholdDbz: 18, minPx: A.minPixelsFor(box) });
  const s = A.locationStats(clean, box, { alarmRadiusKm: 50, thresholdDbz: 18 });
  assert.ok(Math.abs(s.nearest.distanceKm - 34) < 2, `distancia ${s.nearest.distanceKm}`);
  assert.ok(clean.removed >= 1);
});

test('ecos fijos: un punto con eco casi siempre se marca; la lluvia que pasa, no', () => {
  const w = 40, h = 40;
  const m = new ClutterMap(w, h);
  for (let k = 0; k < 150; k++) {
    const dbz = new Float32Array(w * h).fill(NaN);
    const kind = new Uint8Array(w * h);
    dbz[5 * w + 5] = 25; // eco fijo
    // Un frente que cruza la zona de vez en cuando (1 de cada 6 fotogramas).
    if (k % 6 === 0) for (let i = 0; i < w * h; i++) if (i % w > 20) dbz[i] = 30;
    m.update({ w, h, dbz, kind, time: 1000 + k * 600 });
  }
  const mask = m.mask();
  assert.ok(mask && mask[5 * w + 5] === 1, 'el punto fijo está en la máscara');
  assert.strictEqual(mask[10 * w + 30], 0, 'la zona del frente no');
  // Ida y vuelta por disco.
  const back = ClutterMap.fromBuffer(m.toBuffer());
  assert.strictEqual(back.mask()[5 * w + 5], 1);
  assert.strictEqual(back.lastTime, m.lastTime);
  // El mismo fotograma no cuenta dos veces.
  assert.strictEqual(m.update({ w, h, dbz: new Float32Array(w * h), kind: new Uint8Array(w * h), time: m.lastTime }), false);
});

test('movimiento por zonas: dos líneas que se mueven distinto', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 150);
  const kmPx = 1000 / box.mpp;
  const grids = [];
  for (let k = 0; k < 4; k++) {
    const blobs = [];
    // Mitad oeste: hacia el este a 40 km/h. Mitad este: hacia el norte a 40 km/h.
    for (let j = -3; j <= 3; j++) {
      blobs.push({ x: box.w * 0.22 + (j % 2) * 12 * kmPx + k * (40 / 6) * kmPx, y: box.h * 0.5 + j * 18 * kmPx, r: 7 * kmPx, dbz: 30 + (j & 1) * 8 });
      blobs.push({ x: box.w * 0.78 + j * 18 * kmPx, y: box.h * 0.5 + (j % 2) * 12 * kmPx - k * (40 / 6) * kmPx, r: 7 * kmPx, dbz: 32 + (j & 1) * 6 });
    }
    grids.push(gridOf(box, blobs, k * 600));
  }
  const pairs = [];
  for (let i = 1; i < 4; i++) pairs.push({ a: grids[i - 1], b: grids[i], m: A.estimateMotion(grids[i - 1], grids[i], box, 10) });
  const motion = A.combineMotion(pairs.map((p) => p.m), box);
  assert.ok(motion, 'movimiento global');
  const field = A.combineFields(pairs.map((p) => A.estimateMotionField(p.a, p.b, box, 10, p.m)), motion);
  const kmh = (v) => ({ east: (v.vx * box.mpp * 60) / 1000, north: (-v.vy * box.mpp * 60) / 1000 });
  const west = kmh(A.velocityAt(field, motion, box.w * 0.2, box.h * 0.5));
  const east = kmh(A.velocityAt(field, motion, box.w * 0.8, box.h * 0.5));
  assert.ok(west.east > 25 && Math.abs(west.north) < 15, `oeste ${JSON.stringify(west)}`);
  assert.ok(east.north > 25 && Math.abs(east.east) < 15, `este ${JSON.stringify(east)}`);
});

test('previsión por conjunto: probabilidad, margen y más dispersión si hay menos confianza', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 120);
  const kmPx = 1000 / box.mpp;
  // Zona de lluvia de 15 km de radio a 40 km al oeste, viento del oeste a 30 km/h.
  const g = gridOf(box, [{ x: box.cx - 40 * kmPx, y: box.cy, r: 15 * kmPx, dbz: 35 }]);
  const v = (30 * 1000) / 60 / box.mpp; // px/min
  const sure = A.nowcast(g, box, { vx: v, vy: 0, confidence: 0.95, spreadPx: 0 }, { thresholdDbz: 18 });
  const unsure = A.nowcast(g, box, { vx: v, vy: 0, confidence: 0.3, spreadPx: v * 0.4 }, { thresholdDbz: 18 });
  assert.ok(sure.etaMin >= 45 && sure.etaMin <= 60, `eta ${sure.etaMin}`);
  assert.ok(sure.etaEarly <= sure.etaMin && (sure.etaLate === null || sure.etaLate >= sure.etaMin));
  const peak = (nc) => Math.max(...nc.series.filter((s) => s.known).map((s) => s.p));
  assert.ok(peak(sure) > 0.8, `pico seguro ${peak(sure)}`);
  assert.ok(peak(unsure) < peak(sure), `pico dudoso ${peak(unsure)} < ${peak(sure)}`);
  assert.ok(sure.series.every((s) => !s.known || (s.p >= 0 && s.p <= 1)));
});

test('tendencia: una tormenta que se intensifica da tendencia positiva', () => {
  const box = A.boxFor(MADRID.lat, MADRID.lon, 90);
  const kmPx = 1000 / box.mpp;
  const v = (20 * 1000) / 60 / box.mpp;
  const old = gridOf(box, [{ x: box.cx, y: box.cy, r: 15 * kmPx, dbz: 25 }], 0);
  const now = gridOf(box, [{ x: box.cx + v * 20, y: box.cy, r: 15 * kmPx, dbz: 33 }], 1200);
  const tr = A.intensityTrend(old, now, box, 20, { vx: v, vy: 0 }, null);
  const mid = tr.d[Math.floor(tr.nb / 2) * tr.nb + Math.floor(tr.nb / 2)];
  assert.ok(mid > 1, `tendencia ${mid}`);
  assert.ok(A.trendDelta(2, 120) <= 6 && A.trendDelta(2, 120) > 5, 'la tendencia se satura');
});

function radarStatus(now, { lagMin = 10, wetFrom = 40, wetTo = 70, atDbz = null, conf = 0.8 } = {}) {
  const series = [];
  for (let k = 0; k <= 24; k++) {
    const tt = k * 5;
    const wet = tt >= wetFrom && tt <= wetTo;
    series.push({ t: tt, p: wet ? 0.9 : 0.02, rate: wet ? 3 : 0, dbz: wet ? 31 : null, kind: 1, known: true });
  }
  return {
    ok: true, frameTime: (now - lagMin * MIN) / 1000,
    atLocation: { dbz: atDbz, kind: 1, rate: atDbz ? 3 : null, hasData: true },
    nearest: null, nearestAny: { distanceKm: 20, bearingDeg: 270, dbz: 31, kind: 1 },
    motion: { speedKmh: 30, headingDeg: 90, confidence: conf },
    nowcast: { stepMin: 5, etaMin: wetFrom, series }
  };
}

function modelStatus(now, { prob = 10, precip = 0, codeAt = null } = {}) {
  const minutely = [], hourly = [];
  for (let k = 1; k <= 24; k++) minutely.push({ t: now + k * 15 * MIN, precip, snow: 0 });
  for (let k = 1; k <= 24; k++) hourly.push({ t: now + k * 60 * MIN, prob, precip: precip * 4, temp: 15 + k / 4, code: codeAt === k ? 95 : 3 });
  return { ok: true, minutely, hourly, current: {} };
}

test('previsión combinada: el radar manda al principio y el modelo después', () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const loc = { id: 'x', name: 'Casa', alarm: { ...DEFAULT_ALARM } };
  const ol = F.blend({ radar: radarStatus(now), model: modelStatus(now, { prob: 90, precip: 1 }) }, loc, { now });
  // Lluvia del radar a 40 min del fotograma, que tiene 10 min → ~30 min desde ahora.
  assert.strictEqual(ol.eta.min, 30);
  assert.strictEqual(ol.eta.src, 'mix'); // a 40 min del fotograma el radar ya comparte peso
  const at = (min) => ol.series[min / 5];
  assert.strictEqual(at(10).src, 'radar');
  assert.ok(at(180).src === 'model' && Math.abs(at(180).p - 0.9 * F.MODEL_INSTANT) < 1e-9, 'a 3 h solo el modelo');
  assert.ok(at(60).w > 0 && at(60).w < 1, 'a 1 h, mezcla');
  assert.strictEqual(ol.dry.state, 'dry');
  assert.strictEqual(ol.dry.dryUntil, now + 30 * MIN);
});

test('ventana seca: para de llover y cuánto dura la pausa', () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const loc = { id: 'x', name: 'Casa', alarm: { ...DEFAULT_ALARM } };
  // Llueve ahora y hasta +20 min del fotograma; vuelve a +90 (radar sin confianza → modelo seco).
  const r = radarStatus(now, { lagMin: 0, wetFrom: 0, wetTo: 20, atDbz: 30, conf: 0.9 });
  const ol = F.blend({ radar: r, model: modelStatus(now, { prob: 0 }) }, loc, { now });
  assert.ok(ol.wetNow);
  assert.strictEqual(ol.end.min, 25);
  assert.strictEqual(ol.dry.state, 'wet');
  assert.strictEqual(ol.dry.stopsAt, now + 25 * MIN);
  assert.ok(ol.dry.beyond, 'seco hasta el final de lo conocido');
  const txt = D.outlookText(t, ol, now);
  assert.match(txt, /^Para hacia las \d\d:\d\d; después, seco al menos hasta las \d\d:\d\d$/);
});

test('describe: probabilidad y margen en el detalle; ventana seca aparte', () => {
  const now = Date.now();
  const loc = { id: 'x', name: 'Casa', alarm: { ...DEFAULT_ALARM } };
  const d = D.describe({ radar: radarStatus(now), model: modelStatus(now) }, loc, { units: { rate: 'mm', distance: 'km' } }, t, now);
  assert.strictEqual(d.level, 'imminent');
  assert.strictEqual(d.headline, 'Lluvia en ~30 min');
  // 0,77 × 90 % (radar) + 0,23 × 7 % (modelo) ≈ 71 %
  assert.match(d.detail, /probabilidad 71 %/);
  assert.match(d.outlook, /^Seco hasta las \d\d:\d\d \(30 min\)$/);
});

test('resumen del día: tramos de lluvia, tormentas y temperaturas', () => {
  const now = new Date(2026, 9, 6, 7, 30).getTime();
  const m = modelStatus(now, { prob: 10, codeAt: 9 });
  m.hourly[8].prob = 80; m.hourly[8].precip = 2;   // 15:30-16:30
  m.hourly[9].prob = 70; m.hourly[9].precip = 1;   // 16:30-17:30
  const txt = D.daySummary(t, { model: m }, { units: { rate: 'mm', distance: 'km' } }, now);
  assert.match(txt, /^Lluvia probable de 15:30 a 17:30 \(80 %\)\. Total previsto: 3 mm\. Posibles tormentas de 15:30 a 16:30\. Entre \d+ °C y \d+ °C\.$/);
  const dry = D.daySummary(t, { model: modelStatus(now) }, { units: {} }, now);
  assert.match(dry, /^Sin lluvia prevista hoy\./);
});

test('autoverificación: aciertos, falsas alarmas, error de llegada y episodios', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubasco-verify-'));
  const v = new Verifier(dir);
  const T0 = Date.UTC(2026, 9, 6, 12) / 1000;
  const frame = (k, { wet, etaMin = null, p = 0 }) => ({
    ok: true, frameTime: T0 + k * 600,
    atLocation: { dbz: wet ? 30 : null, kind: 1, hasData: true },
    nowcast: { etaMin, series: [10, 20, 30, 60].map((tt) => ({ t: tt, p, known: true })) }
  });
  // k=0..2 seco, prevé lluvia en 30 min (p alta a 30). k=3 llueve (acierto a 30 min).
  v.ingest('a', 18, frame(0, { wet: false, etaMin: 30, p: 0.9 }));
  v.ingest('a', 18, frame(1, { wet: false, etaMin: 20, p: 0.9 }));
  v.ingest('a', 18, frame(2, { wet: false, etaMin: 10, p: 0.9 }));
  v.ingest('a', 18, frame(3, { wet: true }));
  v.ingest('a', 18, frame(3, { wet: true })); // mismo fotograma: se ignora
  const s = v.stats('a');
  assert.strictEqual(s.frames, 4);
  assert.strictEqual(s.leads[30].n, 1);
  assert.strictEqual(s.leads[30].pod, 1);
  // A 10 min: las previsiones de k=0 y k=1 fallan (seguía seco); la de k=2 acierta.
  assert.strictEqual(s.leads[10].far, 2 / 3);
  assert.ok(s.eta && s.eta.n === 3 && s.eta.mae === 0, `eta ${JSON.stringify(s.eta)}`);
  assert.deepStrictEqual({ hit: s.episodes.hit, missed: s.episodes.missed, fa: s.episodes.fa, lead: s.episodes.lead }, { hit: 1, missed: 0, fa: 0, lead: 30 });
  v.flush();
  const again = new Verifier(dir);
  assert.strictEqual(again.stats('a').frames, 4, 'se guarda en disco');
  assert.ok(fs.readFileSync(path.join(dir, 'verify-log.jsonl'), 'utf8').trim().split('\n').length === 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rayos: un aviso por episodio y se rearma tras 30 min sin rayos', () => {
  const loc = { id: 'a', name: 'Casa', lat: 40, lon: -3, alarm: { ...DEFAULT_ALARM } };
  const settings = { units: { rate: 'mm', distance: 'km' } };
  const T0 = Date.UTC(2026, 9, 6, 18);
  let state = freshState();
  const step = (m, nearest) => {
    const res = evaluate({ loc, status: { lightning: { ok: true, nearest } }, state, now: T0 + m * MIN, settings, t });
    state = res.state;
    return res.alerts;
  };
  const a = step(0, { distanceKm: 12, bearingDeg: 270, ageMin: 15 });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].title, 'Rayos a 12 km de Casa');
  assert.match(a[0].body, /al oeste, vista por satélite hace 15 min/);
  assert.strictEqual(step(5, { distanceKm: 8, bearingDeg: 270, ageMin: 15 }).length, 0);
  assert.strictEqual(step(10, { distanceKm: 40, bearingDeg: 270, ageMin: 15 }).length, 0); // lejos
  assert.strictEqual(step(30, null).length, 0);
  assert.strictEqual(step(45, { distanceKm: 10, bearingDeg: 0, ageMin: 15 }).length, 1, 'nuevo episodio');
});

test('vigilancia: un fotograma nuevo dispara la comprobación sin esperar', async () => {
  let T = 1000, analyses = 0;
  const loc = { id: 'a', name: 'Casa', lat: 40, lon: -3, alarm: { ...DEFAULT_ALARM } };
  const store = { data: { locations: [loc], activeLocationId: 'a' }, settings: { checkIntervalMin: 5, units: {} } };
  const radar = {
    getMaps: async () => ({ frames: [{ time: T }] }),
    analyze: async () => { analyses++; return { ok: true, frameTime: T, atLocation: { dbz: null, kind: 0, hasData: true }, nowcast: { series: [] } }; }
  };
  const weather = { forecast: async () => ({ ok: true, updatedAt: Date.now(), minutely: [], hourly: [] }) };
  const m = new Monitor({ store, radar, weather, getT: () => t, onUpdate: () => {}, onAlerts: () => {} });
  await m.watch();
  assert.strictEqual(analyses, 1);
  await m.watch();
  assert.strictEqual(analyses, 1, 'mismo fotograma: nada');
  T += 600;
  await m.watch();
  assert.strictEqual(analyses, 2);
  m.stop();
});

test('lluvia que solo prevé el modelo: no se anuncia como "llega en X min"', () => {
  const now = Date.now();
  const loc = { id: 'x', name: 'Casa', alarm: { ...DEFAULT_ALARM } };
  const r = radarStatus(now, { wetFrom: 999, wetTo: 999 }); // el radar no ve nada que venga
  const d = D.describe({ radar: r, model: modelStatus(now, { prob: 100, precip: 1 }) }, loc, { units: {} }, t, now);
  assert.ok(!['imminent', 'approaching'].includes(d.level), d.level);
  assert.match(d.outlook, /^Seco hasta las/);
  const res = evaluate({ loc, status: { radar: r, model: modelStatus(now, { prob: 100, precip: 1 }) }, state: freshState(), now, settings: { units: {} }, t });
  assert.ok(!res.alerts.some((a) => a.type === 'imminent'));
});

test('«avísame cuando pare»: espera a que haya bastantes minutos secos', () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const loc = { id: 'x', name: 'Casa', alarm: { ...DEFAULT_ALARM }, dryWatch: { minMin: 30, since: now, until: now + 8 * 3600000 } };
  const ev = (status) => evaluate({ loc, status, state: freshState(), now, settings: { units: {} }, t }).alerts.filter((a) => a.type === 'dryWindow');
  // Llueve ahora: nada.
  assert.strictEqual(ev({ radar: radarStatus(now, { lagMin: 0, wetFrom: 0, wetTo: 20, atDbz: 30 }), model: modelStatus(now, { prob: 0 }) }).length, 0);
  // Seco, pero vuelve a llover en ~20 min: aún no.
  assert.strictEqual(ev({ radar: radarStatus(now, { lagMin: 0, wetFrom: 20, wetTo: 60 }), model: modelStatus(now, { prob: 0 }) }).length, 0);
  // Seco y sin lluvia en las próximas horas: aviso.
  const a = ev({ radar: radarStatus(now, { lagMin: 0, wetFrom: 999, wetTo: 999 }), model: modelStatus(now, { prob: 0 }) });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].title, 'Ventana seca en Casa');
  assert.match(a[0].body, /^Sin lluvia prevista al menos hasta las \d\d:\d\d\.$/);
  // Con la alarma apagada también funciona; caducado, no.
  assert.strictEqual(evaluate({ loc: { ...loc, alarm: { ...loc.alarm, enabled: false } }, status: { radar: radarStatus(now, { lagMin: 0, wetFrom: 999, wetTo: 999 }), model: modelStatus(now, { prob: 0 }) }, state: freshState(), now, settings: { units: {} }, t }).alerts.length, 1);
  assert.strictEqual(evaluate({ loc: { ...loc, dryWatch: { ...loc.dryWatch, until: now - 1 } }, status: { radar: radarStatus(now, { lagMin: 0, wetFrom: 999, wetTo: 999 }), model: modelStatus(now, { prob: 0 }) }, state: freshState(), now, settings: { units: {} }, t }).alerts.filter((x) => x.type === 'dryWindow').length, 0);
});

test('móvil (ntfy): publica en JSON con título, prioridad y etiquetas', async () => {
  const { sendPush, newTopic } = require('../src/main/push');
  const topic = newTopic();
  assert.match(topic, /^chubasco-[\w-]{16}$/);
  let sent = null;
  const fetch = async (url, opts) => { sent = { url, ...opts, json: JSON.parse(opts.body) }; return { ok: true }; };
  await sendPush({ fetch, userAgent: 'x', push: { server: 'https://ntfy.sh/', topic }, title: 'Lluvia en ~15 min en Córdoba', body: 'Débil', type: 'imminent' });
  assert.strictEqual(sent.url, 'https://ntfy.sh');
  assert.deepStrictEqual(sent.json, { topic, title: 'Lluvia en ~15 min en Córdoba', message: 'Débil', tags: ['umbrella'], priority: 4 });
  await assert.rejects(sendPush({ fetch, userAgent: 'x', push: { server: 'http://inseguro', topic }, title: 'a', body: 'b', type: 'test' }));
});

test('trayectos: dónde llueve, sugerencia de hora y cuándo toca comprobar', () => {
  const C = require('../src/main/commute');
  const now = Date.UTC(2026, 9, 6, 17, 30);
  const from = { lat: 40.40, lon: -3.70 }, to = { lat: 40.45, lon: -3.60 };
  const points = C.routePoints(from, to);
  assert.strictEqual(points.length, 6);
  assert.deepStrictEqual([points[0].f, points[5].f], [0, 1]);
  // Radar: llueve en el tramo final entre +30 y +45 min desde ahora (fotograma de ahora).
  const series = (wet) => Array.from({ length: 25 }, (_, k) => ({ t: k * 5, p: wet(k * 5) ? 0.9 : 0.02, rate: wet(k * 5) ? 4 : 0, dbz: null, kind: 1, known: true }));
  const radar = {
    ok: true, frameTime: now / 1000, motion: { confidence: 0.9 },
    points: points.map((pt) => ({ nowcast: { stepMin: 5, series: series((tt) => pt.f > 0.6 && tt >= 30 && tt <= 45) } }))
  };
  const alarm = { ...DEFAULT_ALARM };
  const depTs = now + 10 * 60000; // sale a +10, llega a +40
  const res = C.evaluateCommute({ radar, model: null, alarm, points, depTs, durationMin: 30, now });
  assert.ok(res.pMax >= 0.85, `p ${res.pMax}`);
  assert.strictEqual(res.where, 'end');
  assert.ok(res.suggest && res.suggest.offsetMin !== 0 && res.suggest.pMax < 0.4, 'sugiere otra hora');
  const txt = C.commuteText(t, res, { fromName: 'Casa', toName: 'Trabajo', time: '17:40', depTs, units: {} });
  assert.match(txt.title, /^Casa → Trabajo a las 17:40: probable lluvia$/);
  assert.match(txt.body, /sobre todo al llegar/);
  assert.match(txt.body, /Saliendo a las \d\d:\d\d baja al \d+ %\.$/);
  // Toca comprobar 30 min antes, una sola vez.
  const local = new Date(2026, 9, 6, 8, 0).getTime(); // martes
  const c = { enabled: true, time: '08:15', days: [1, 2, 3, 4, 5], leadMin: 30, lastKey: null };
  assert.strictEqual(C.dueKey(c, local - 20 * 60000), null);            // 7:40: aún no
  const key = C.dueKey(c, local - 10 * 60000);                           // 7:50: sí
  assert.ok(key);
  assert.strictEqual(C.dueKey({ ...c, lastKey: key }, local - 5 * 60000), null);
  assert.strictEqual(C.dueKey({ ...c, days: [0, 6] }, local - 10 * 60000), null); // fin de semana
});

test('calibración: se activa con datos, corrige probabilidades optimistas y aprende el peso del radar', () => {
  const { calibrationMap, calibrateP, calibrateRadar } = require('../src/main/verify');
  // Mapa creciente aunque los datos no lo sean, y encogido hacia la diagonal.
  const m = calibrationMap([100, 100, 100, 100, 100], [5, 40, 30, 60, 90]);
  for (let i = 1; i < m.length; i++) assert.ok(m[i] >= m[i - 1] - 1e-12, 'creciente');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubasco-cal-'));
  const v = new Verifier(dir);
  const T0 = Date.UTC(2026, 9, 1) / 1000;
  // 400 fotogramas: el radar dice 90 % a todos los plazos, pero solo llueve 1 de cada 2 veces.
  // El modelo dice siempre 50 % (mejor calibrado): el peso del radar debe salir bajo.
  const model = { ok: true, minutely: [], hourly: [] };
  for (let k = 0; k < 2000; k++) model.hourly.push({ t: (T0 + k * 3600) * 1000, prob: 50 / 0.7, precip: 0 });
  for (let k = 0; k < 400; k++) {
    v.ingest('a', 18, {
      ok: true, frameTime: T0 + k * 600,
      atLocation: { dbz: k % 2 ? 30 : null, kind: 1, hasData: true },
      nowcast: { etaMin: null, series: [10, 20, 30, 60].map((tt) => ({ t: tt, p: 0.9, known: true })) }
    }, model);
  }
  const cal = v.calibration();
  assert.ok(cal.active);
  const c30 = cal.leads[30];
  assert.ok(c30.active && c30.n >= 300);
  assert.ok(Math.abs(calibrateP(0.9, 30, cal) - 0.5) < 0.06, `0,9 → ${calibrateP(0.9, 30, cal)}`);
  assert.ok(c30.wActive && c30.w < 0.2, `peso ${c30.w}`);
  const r = calibrateRadar({ ok: true, nowcast: { series: [{ t: 0, p: 1 }, { t: 30, p: 0.9 }] }, points: [] }, cal);
  assert.strictEqual(r.nowcast.series[0].p, 1, 't=0 es observación: no se toca');
  assert.ok(r.nowcast.series[1].p < 0.6 && r.nowcast.series[1].pRaw === 0.9);
  assert.ok(r.calib && r.calib.weights[30] < 0.2);
  // Sin datos suficientes, nada cambia.
  const fresh = new Verifier(fs.mkdtempSync(path.join(os.tmpdir(), 'chubasco-cal2-')));
  assert.strictEqual(fresh.calibration().active, false);
  const same = { ok: true, nowcast: { series: [] } };
  assert.strictEqual(calibrateRadar(same, fresh.calibration()), same);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tormenta fuerte: núcleo ≥55 dBZ con rayos cerca → aviso, una vez por episodio', () => {
  const now = Date.UTC(2026, 9, 6, 18);
  const loc = { id: 'a', name: 'Casa', alarm: { ...DEFAULT_ALARM } };
  const r = (dbz, km) => ({ ...radarStatus(now, { wetFrom: 999, wetTo: 999 }), strongest: { dbz, kind: 1, distanceKm: km, bearingDeg: 270 } });
  const light = { ok: true, nearest: { distanceKm: 15, bearingDeg: 270, ageMin: 15 } };
  assert.strictEqual(D.severeStorm({ radar: r(50, 10), lightning: light }, loc), null, '50 dBZ no basta');
  assert.strictEqual(D.severeStorm({ radar: r(56, 10), lightning: { ok: true, nearest: null } }, loc), null, 'sin rayos y < 60 dBZ: no');
  assert.ok(D.severeStorm({ radar: r(56, 10), lightning: light }, loc).lightning);
  assert.ok(D.severeStorm({ radar: r(62, 10), lightning: null }, loc), '≥ 60 dBZ aunque no haya datos de rayos');
  assert.strictEqual(D.severeStorm({ radar: r(62, 45), lightning: light }, loc), null, 'demasiado lejos');
  let state = freshState();
  const ev = (m, status) => { const res = evaluate({ loc, status, state, now: now + m * MIN, settings: { units: {} }, t }); state = res.state; return res.alerts.filter((x) => x.type === 'severe'); };
  const st = { radar: r(57, 12), lightning: light };
  const first = ev(0, st);
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].title, 'Tormenta fuerte cerca de Casa');
  assert.match(first[0].body, /Núcleo muy intenso con rayos a 12 km al oeste: posible granizo/);
  assert.strictEqual(ev(10, st).length, 0, 'no se repite');
  const d = D.describe(st, loc, { units: {} }, t, now);
  assert.match(d.severe, /^Tormenta fuerte a 12 km al oeste, con rayos/);
});

test('actualizaciones: sin dueño real no se comprueba nada; comparación de versiones', () => {
  const { repoInfo, isNewer } = require('../src/main/updates');
  assert.strictEqual(repoInfo({ build: { publish: [{ provider: 'github', owner: 'TU_USUARIO', repo: 'chubasco' }] } }), null, 'con el usuario provisional no hay repo');
  assert.deepStrictEqual(repoInfo(require('../package.json')), { owner: 'lalesena', repo: 'chubasco' });
  // Así queda package.json dentro de la app empaquetada: sin "build".
  assert.deepStrictEqual(repoInfo({ repository: { type: 'git', url: 'https://github.com/lalesena/chubasco.git' } }), { owner: 'lalesena', repo: 'chubasco' });
  assert.strictEqual(repoInfo({ repository: { url: 'https://github.com/TU_USUARIO/chubasco.git' } }), null);
  assert.strictEqual(repoInfo({}), null);
  assert.deepStrictEqual(repoInfo({ build: { publish: [{ provider: 'github', owner: 'ana', repo: 'chubasco' }] } }), { owner: 'ana', repo: 'chubasco' });
  assert.ok(isNewer('v1.2.0', '1.1.9'));
  assert.ok(isNewer('1.10.0', '1.9.3'));
  assert.ok(!isNewer('v1.0.0', '1.0.0'));
  assert.ok(!isNewer('0.9.9', '1.0.0'));
});
