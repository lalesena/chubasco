'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PNG } = require('pngjs');
const RA_PNG = require('../src/shared/png');
const { Store, StoreCore } = require('../src/main/store');
const D = require('../src/shared/describe');
const I18N = require('../src/shared/i18n');
const P = require('../src/shared/palette');

// --------------------------------------------------------------------------
// Decodificador PNG

function randomImage(w, h, seed) {
  const png = new PNG({ width: w, height: h });
  let s = seed;
  for (let i = 0; i < png.data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; png.data[i] = s >> 16 & 255; }
  return png;
}

test('png: igual que pngjs en RGBA, RGB, gris y gris+alfa con todos los filtros', async () => {
  for (const colorType of [0, 2, 4, 6]) {
    for (const filterType of [0, 1, 2, 3, 4]) {
      const buf = PNG.sync.write(randomImage(23, 17, colorType * 7 + filterType), { colorType, filterType });
      const ref = PNG.sync.read(buf);
      const got = await RA_PNG.decode(buf);
      assert.strictEqual(got.width, 23);
      assert.strictEqual(got.height, 17);
      assert.deepStrictEqual(Buffer.from(got.data), Buffer.from(ref.data), `colorType ${colorType}, filtro ${filterType}`);
    }
  }
});

// PNG hecho a mano (el CRC no se comprueba).
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function handPng({ w, h, depth, type, rows, plte, trns, interlace = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth; ihdr[9] = type; ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []), ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

test('png: paleta de 2 bits con transparencia', async () => {
  const buf = handPng({
    w: 3, h: 2, depth: 2, type: 3,
    plte: [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255], trns: [255, 128],
    rows: [[0b00011000], [0b11000100]] // índices 0 1 2 / 3 0 1
  });
  const { data } = await RA_PNG.decode(buf);
  assert.deepStrictEqual(Array.from(data), [
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255,
    255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 128
  ]);
});

test('png: gris de 1 bit y RGB de 16 bits con color transparente', async () => {
  const gray = await RA_PNG.decode(handPng({ w: 9, h: 1, depth: 1, type: 0, rows: [[0b10110001, 0b10000000]] }));
  assert.deepStrictEqual(Array.from({ length: 9 }, (_, i) => gray.data[i * 4]), [255, 0, 255, 255, 0, 0, 0, 255, 255]);
  const rgb = await RA_PNG.decode(handPng({
    w: 2, h: 1, depth: 16, type: 2, trns: [0, 1, 0, 2, 0, 3],
    rows: [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0, 1, 0, 2, 0, 3]]
  }));
  assert.deepStrictEqual(Array.from(rgb.data), [0x12, 0x56, 0x9a, 255, 0, 0, 0, 0]);
});

test('png: rechaza lo que no es PNG y los entrelazados', async () => {
  await assert.rejects(RA_PNG.decode(Buffer.from('hola')), /no válido/);
  await assert.rejects(RA_PNG.decode(handPng({ w: 1, h: 1, depth: 8, type: 0, rows: [[0]], interlace: 1 })), /entrelazado/);
});

// --------------------------------------------------------------------------
// Datos: núcleo común y persistencia en disco

test('StoreCore: valores por defecto del widget, migraciones y guardado a través de persist()', async () => {
  const saved = [];
  class Mem extends StoreCore { persist(d) { saved.push(JSON.parse(JSON.stringify(d))); } }
  const s = new Mem({ settings: { baseMap: 'satellite', widget: { size: 'large' } }, locations: [{ id: 'a', name: 'A', lat: 1, lon: 2 }] });
  assert.strictEqual(s.settings.baseMap, 'auto');
  assert.deepStrictEqual(s.settings.widget, { enabled: false, size: 'large', onTop: false, locationId: null, x: null, y: null });
  assert.strictEqual(s.data.locations[0].alarm.radiusKm, 25);
  const loc = s.addLocation({ name: 'B', lat: 3, lon: 4 });
  assert.match(loc.id, /^[0-9a-f-]{36}$/);
  s.flush();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].locations.length, 2);
});

test('Store: guarda en JSON y aparta un fichero ilegible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubasco-store-'));
  const a = new Store(dir);
  a.addLocation({ name: 'Madrid', lat: 40.4, lon: -3.7 });
  a.flush();
  assert.strictEqual(new Store(dir).data.locations[0].name, 'Madrid');
  fs.writeFileSync(path.join(dir, 'chubasco.json'), '{roto');
  const b = new Store(dir);
  assert.strictEqual(b.data.locations.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'chubasco.json.bad')));
});

// --------------------------------------------------------------------------
// Texto breve del widget

const NOW = Date.UTC(2026, 9, 7, 10, 0);
const t = I18N.make('es');
const loc = { alarm: { level: 'light', radiusKm: 25, imminentMin: 30, minProb: 0.5 } };
const dryModel = {
  ok: true, updatedAt: NOW,
  minutely: Array.from({ length: 24 }, (_, i) => ({ t: NOW + i * 15 * 60000, precip: 0, snow: 0 })),
  hourly: Array.from({ length: 24 }, (_, i) => ({ t: NOW + i * 3600000, prob: 5, precip: 0, temp: 15, code: 1 })),
  nextRain: null
};
const series = (fn) => Array.from({ length: 25 }, (_, i) => ({ t: i * 5, ...fn(i) }));

test('brief: sin lluvia, una línea corta para el widget pequeño', () => {
  const radar = {
    ok: true, frameTime: NOW / 1000, missingFraction: 0, atLocation: { dbz: null }, nearest: null, nearestAny: null,
    motion: null, nowcast: { etaMin: null, endMin: null, stepMin: 5, series: series(() => ({ p: 0, dbz: null, kind: 0, known: true, rate: 0 })) }
  };
  const b = D.brief({ radar, model: dryModel }, loc, { units: {} }, t, NOW);
  assert.strictEqual(b.level, 'clear');
  assert.match(b.sub, /^Seco/);
  assert.match(b.subShort, /^Seco hasta las \d\d:\d\d$/);
});

test('brief: lloviendo, intensidad y cuándo para', () => {
  const dbz = 30;
  const radar = {
    ok: true, frameTime: NOW / 1000, missingFraction: 0,
    atLocation: { dbz, kind: P.KIND_RAIN, rate: P.dbzToRate(dbz, P.KIND_RAIN) }, nearest: null, nearestAny: null, motion: null,
    nowcast: { etaMin: 0, endMin: 20, stepMin: 5, series: series((i) => (i < 4 ? { p: 0.95, dbz, kind: 1, known: true, rate: 2.7 } : { p: 0.02, dbz: null, kind: 0, known: true, rate: 0 })) }
  };
  const b = D.brief({ radar, model: dryModel }, loc, { units: {} }, t, NOW);
  assert.strictEqual(b.level, 'raining');
  assert.match(b.sub, /mm\/h · termina en ~\d+ min/);
  assert.match(b.subShort, /^Termina en ~\d+ min$/);
});

// --------------------------------------------------------------------------
// Motor de la versión web (sin red: cada petición falla al momento)

function engine(opts) {
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('sin red en las pruebas'); };
  const { createEngine } = require('../web/src/engine');
  const e = createEngine({ locale: 'es-ES', version: '9.9.9', initial: null, embed: null, open: null, ...opts, post: (m) => posted.push(m) });
  return { e, posted, restore: () => { globalThis.fetch = realFetch; } };
}

test('motor web: widget insertado con una sola ubicación y sin guardar nada', async () => {
  const { e, posted, restore } = engine({
    embed: { place: { lat: 40.4, lon: -3.7, name: 'Madrid' }, size: 'small', lang: 'en', units: { rate: 'in', distance: 'mi' }, appUrl: 'https://x/?lat=40.4' }
  });
  try {
    const st = await e.call('getState', []);
    assert.strictEqual(st.platform, 'web');
    assert.deepStrictEqual(st.embed, { size: 'small', appUrl: 'https://x/?lat=40.4' });
    assert.strictEqual(st.locations.length, 1);
    assert.strictEqual(st.locations[0].name, 'Madrid');
    assert.strictEqual(st.settings.language, 'en');
    await new Promise((r) => setTimeout(r, 450));
    assert.ok(!posted.some((m) => m.type === 'persist'));
  } finally { restore(); }
});

test('motor web: guarda en el navegador y valida', async () => {
  const initial = { locations: [{ id: 'm', name: 'Madrid', lat: 40.4168, lon: -3.7038 }], activeLocationId: 'm' };
  const { e, posted, restore } = engine({ initial });
  try {
    e.call('updateSettings', [{ theme: 'dark' }]);
    assert.ok(posted.some((m) => m.type === 'event' && m.event === 'settings' && m.payload.settings.theme === 'dark'));
    await assert.rejects(e.call('addLocation', [{ name: 'X', lat: 95, lon: 0 }]), /Coordenadas/);
    const toledo = await e.call('addLocation', [{ name: 'Toledo', lat: 39.86, lon: -4.03 }]);
    const st = await e.call('getState', []);
    assert.strictEqual(st.activeLocationId, toledo.id);
    assert.throws(() => e.call('borrarTodo', []), /desconocido/);
    await new Promise((r) => setTimeout(r, 450));
    const saved = posted.filter((m) => m.type === 'persist').pop();
    assert.deepStrictEqual(saved.data.locations.map((l) => l.name), ['Madrid', 'Toledo']);
  } finally { restore(); }
});
