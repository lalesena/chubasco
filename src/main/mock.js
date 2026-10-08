'use strict';
/*
 * Modo demostración (CHUBASCO_MOCK=1 / `npm run demo`): intercepta las
 * peticiones HTTPS y sirve datos sintéticos — una línea de tormentas que
 * avanza hacia Madrid, en el radar OPERA — para probar la interfaz y las
 * alarmas sin red.
 */
const { protocol } = require('electron');
const { PNG } = require('pngjs');
const { operaFile } = require('./mock-opera');
const { BASE_URL, DELAY } = require('./opera');

const HOME = { lat: 40.4168, lon: -3.7038 };

const CELLS = [
  { x0: -62, y0: 12, r: 24, peak: 44 },
  { x0: -36, y0: -6, r: 15, peak: 36 },
  { x0: -88, y0: -10, r: 20, peak: 31 },
  { x0: 30, y0: 70, r: 11, peak: 24 },
  { x0: -150, y0: 40, r: 30, peak: 38 },
  { x0: 140, y0: -120, r: 26, peak: 33 }
];
const V = { x: 30, y: 7 }; // km/h

function noise(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function dbzAt(kmx, kmy, tMin) {
  let best = -Infinity;
  for (const c of CELLS) {
    const cx = c.x0 + (V.x * tMin) / 60;
    const cy = c.y0 + (V.y * tMin) / 60;
    const dx = kmx - cx, dy = kmy - cy;
    const ang = Math.atan2(dy, dx);
    const wobble = 1 + 0.18 * Math.sin(ang * 3 + c.r) + 0.08 * Math.sin(ang * 7);
    const d = Math.hypot(dx, dy) / (c.r * wobble);
    if (d >= 1) continue;
    const n = noise(Math.round(dx * 0.7), Math.round(dy * 0.7));
    const v = 8 + (c.peak - 8) * Math.pow(1 - d, 0.8) + (n - 0.5) * 4;
    if (v > best) best = v;
  }
  return best;
}

// Radar OPERA: el mismo frente de tormentas en la rejilla europea.
const OPERA_HOST = new URL(BASE_URL).host;
const operaFiles = new Map();
function operaFor(time) {
  if (!operaFiles.has(time)) {
    const tMin = (time - Date.now() / 1000) / 60;
    const cosLat = Math.cos((HOME.lat * Math.PI) / 180);
    const file = operaFile((lat, lon) => {
      const v = dbzAt((lon - HOME.lon) * 111.2 * cosLat, (lat - HOME.lat) * 111.2, tMin);
      return v < 10 ? NaN : v;
    }, { lat0: HOME.lat - 3, lat1: HOME.lat + 3, lon0: HOME.lon - 4, lon1: HOME.lon + 4 });
    operaFiles.set(time, file);
    if (operaFiles.size > 16) operaFiles.delete(operaFiles.keys().next().value);
  }
  return operaFiles.get(time);
}

function operaResponse(req, u) {
  const m = /OPERA@(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})@/.exec(u.pathname);
  if (!m) return new Response('', { status: 404 });
  const time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  if (time > Date.now() / 1000 - DELAY) return new Response('', { status: 404 }); // aún no publicado
  const file = operaFor(time);
  const r = /bytes=(\d+)-(\d+)/.exec(req.headers.get('range') || '');
  if (!r) return new Response(file.read(0, file.size - 1));
  const bytes = file.read(+r[1], +r[2]);
  return new Response(bytes, { status: 206, headers: { 'content-range': `bytes ${r[1]}-${+r[1] + bytes.length - 1}/${file.size}` } });
}

// Rayos (imita la capa li_afa de EUMETSAT): destellos en los núcleos de más de 34 dBZ.
const LI_STEP = 5 * 60000;
function lightningLatest() {
  return Math.floor(Date.now() / LI_STEP) * LI_STEP - 15 * 60000;
}

function lightningTile(u) {
  const q = u.searchParams;
  const w = Number(q.get('width')) || 256, h = Number(q.get('height')) || 256;
  const [x0, y0, x1, y1] = (q.get('bbox') || '0,0,0,0').split(',').map(Number);
  const merc = /3857|900913/.test(q.get('srs') || q.get('crs') || '');
  const time = Date.parse(q.get('time') || '') || lightningLatest();
  const tMin = (time - Date.now()) / 60000;
  const cosLat = Math.cos((HOME.lat * Math.PI) / 180);
  const png = new PNG({ width: w, height: h });
  for (let py = 0; py < h; py++) {
    const yy = y1 - ((py + 0.5) / h) * (y1 - y0);
    const lat = merc ? (Math.atan(Math.sinh(yy / 6378137)) * 180) / Math.PI : yy;
    for (let px = 0; px < w; px++) {
      const xx = x0 + ((px + 0.5) / w) * (x1 - x0);
      const lon = merc ? (xx / 6378137) * (180 / Math.PI) : xx;
      const v = dbzAt((lon - HOME.lon) * 111.2 * cosLat, (lat - HOME.lat) * 111.2, tMin);
      if (v < 34) continue;
      const o = (py * w + px) * 4;
      png.data[o] = 254; png.data[o + 1] = v > 40 ? 120 : 200; png.data[o + 2] = 60; png.data[o + 3] = 230;
    }
  }
  return PNG.sync.write(png);
}

// Agua en España: valores inventados con la forma de agua.json. Los
// embalses, con nombres del inventario para que salgan en el mapa.
function demoNames(b) {
  const items = Object.keys(require('../shared/embalses').items).filter((k) => k.startsWith(b.id + '|')).map((k) => k.slice(b.id.length + 1));
  return items.length >= 3 ? items.slice(0, 3) : [0, 1, 2].map((k) => `Embalse ${b.name.split(' ')[0]} ${k + 1}`);
}

function aguaDemo() {
  const { basins } = require('../shared/cuencas');
  const now = Date.now();
  const wave = (i, k) => 0.5 + 0.5 * Math.sin(i * 1.7 + k);
  const weekDates = Array.from({ length: 53 }, (_, k) => new Date(now - (52 - k) * 7 * 86400000).toISOString().slice(0, 10));
  const res = { basins: {} };
  let cap = 0, vol = 0;
  basins.forEach((b, i) => {
    if (!b.ambitos.length) return;
    const c = Math.round(b.areaKm2 / 8), pct = Math.round(300 + 450 * wave(i, 0)) / 10;
    const weeks = weekDates.map((_, k) => Math.round(10 * (pct - 8 * Math.sin((52 - k) / 9 + i))) / 10);
    cap += c; vol += (c * pct) / 100;
    res.basins[b.id] = {
      cap: c, vol: Math.round((c * pct) / 100), pct, prevPct: Math.round(10 * (pct - 0.4 + wave(i, 2))) / 10,
      lastYearPct: Math.round(10 * (pct - 10 + 15 * wave(i, 1))) / 10, avg10Pct: Math.round(10 * (pct - 5 + 8 * wave(i, 3))) / 10,
      n: 3, weeks, weeksAvg: weeks.map((w, k) => Math.round(10 * (w - 3 + 4 * Math.sin(k / 7))) / 10),
      list: demoNames(b).map((name, k) => ({ name, cap: Math.round(c / (k + 2)), vol: Math.round((c / (k + 2)) * (pct / 100)), prev: Math.round((c / (k + 2)) * ((pct - 0.5) / 100)) }))
    };
  });
  res.total = { cap, vol: Math.round(vol), pct: Math.round((1000 * vol) / cap) / 10, prevPct: 52.1, lastYearPct: 47.5, avg10Pct: 50.3 };
  res.weekDates = weekDates;
  res.date = weekDates[52];
  const rain = { until: new Date(Math.floor(now / 3600000) * 3600000).toISOString(), hydroYearStart: '2026-10-01', basins: {} };
  basins.forEach((b, i) => {
    const serie = Array.from({ length: 30 }, (_, k) => Math.round(Math.max(0, 12 * Math.sin(k / 3 + i) - 4) * 10) / 10);
    rain.basins[b.id] = { h24: serie[29], d7: Math.round(serie.slice(-7).reduce((a, x) => a + x, 0)), d30: Math.round(serie.reduce((a, x) => a + x, 0)), year: Math.round(serie.slice(-8).reduce((a, x) => a + x, 0)), cover: 0.97, serie };
  });
  return { updated: new Date(now).toISOString(), sources: {}, rain, reservoirs: res };
}

// Histórico de los embalses de una cuenca, con la forma de embalses/<id>.json.
function aguaHistDemo(id) {
  const b = require('../shared/cuencas').basins.find((x) => x.id === id);
  if (!b) return null;
  const now = Date.now();
  const weekDates = Array.from({ length: 53 }, (_, k) => new Date(now - (52 - k) * 7 * 86400000).toISOString().slice(0, 10));
  const r1 = (v) => Math.round(v * 10) / 10;
  const res = {};
  demoNames(b).forEach((name, i) => {
    const w = weekDates.map((_, k) => r1(55 + 25 * Math.sin(k / 8 + i)));
    const months = Array.from({ length: 12 * 38 + 9 }, (_, k) => Math.round(55 + 30 * Math.sin(k / 5 + i) * Math.cos(k / 70)));
    res[name] = {
      w, avg: w.map((v, k) => r1(60 + 15 * Math.sin(k / 8 + i + 0.6))), lo: w.map((v, k) => Math.round(25 + 10 * Math.sin(k / 8))), hi: w.map((v, k) => Math.round(92 + 6 * Math.sin(k / 8))),
      y0: 1988, yrs: Array.from({ length: 38 }, (_, k) => r1(50 + 35 * Math.sin(k * 0.9 + i))),
      m0: '1988-01', m: months, max: [99.1, '2014-03-18'], min: [11.4, '1995-10-03'], since: '1988-01-05'
    };
  });
  return { date: weekDates[52], weekDates, total: { m0: '1988-01', m: Array.from({ length: 12 * 38 + 9 }, (_, k) => Math.round(55 + 20 * Math.sin(k / 9) * Math.cos(k / 60))) }, res };
}

// Pluviómetros, con la forma de pluvio.json: [id, nombre, lat, lon, 1 h, 24 h, 7 días, 30 días].
function pluvioDemo() {
  const stations = [];
  for (let i = 0; i < 70; i++) {
    const lat = 36.4 + ((i * 37) % 70) / 10, lon = -8.6 + ((i * 53) % 115) / 10;
    const wet = Math.max(0, Math.sin(i * 0.7) * 18);
    stations.push([`D${i}`, `Estación ${i + 1}`, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, i % 5 === 0 ? Math.round(wet / 4) / 2 : 0, Math.round(wet * 10) / 10, Math.round(wet * 25) / 10, null]);
  }
  return { source: '© AEMET', until: new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString(), stations };
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
}
function png(buf) {
  return new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=600' } });
}

function forecast() {
  const now = Math.floor(Date.now() / 1000);
  const q = now - (now % 900) + 900;
  const minutely = { time: [], precipitation: [], snowfall: [] };
  for (let i = 0; i < 24; i++) {
    const t = q + i * 900;
    minutely.time.push(t);
    const m = (t - now) / 60;
    minutely.precipitation.push(m > 35 && m < 110 ? +(0.3 + 0.9 * Math.sin(((m - 35) / 75) * Math.PI)).toFixed(1) : 0);
    minutely.snowfall.push(0);
  }
  const h0 = now - (now % 3600) + 3600;
  const hourly = { time: [], precipitation_probability: [], precipitation: [], temperature_2m: [], weather_code: [] };
  for (let i = 0; i < 24; i++) {
    hourly.time.push(h0 + i * 3600);
    const p = i < 3 ? [70, 85, 55][i] : i > 14 && i < 19 ? 40 : 10;
    hourly.precipitation_probability.push(p);
    hourly.precipitation.push(i < 3 ? [1.8, 3.2, 0.6][i] : i === 16 ? 0.4 : 0);
    hourly.temperature_2m.push(17 - Math.abs(12 - i) * 0.4);
    hourly.weather_code.push(i < 3 ? 63 : 2);
  }
  return {
    utc_offset_seconds: 7200,
    current: { temperature_2m: 17.4, precipitation: 0, weather_code: 3, wind_speed_10m: 21, is_day: 1 },
    minutely_15: minutely, hourly
  };
}

function install() {
  protocol.handle('https', async (req) => {
    const u = new URL(req.url);
    if (u.host === OPERA_HOST) return operaResponse(req, u);
    if (u.host.endsWith('.github.io') && u.pathname.endsWith('/agua/agua.json')) return json(aguaDemo());
    if (u.host.endsWith('.github.io') && u.pathname.endsWith('/agua/pluvio.json')) return json(pluvioDemo());
    const hist = u.host.endsWith('.github.io') && /\/agua\/embalses\/(ES\d{3})\.json$/.exec(u.pathname);
    if (hist) { const h = aguaHistDemo(hist[1]); return h ? json(h) : new Response('', { status: 404 }); }
    if (u.host === 'api.open-meteo.com') return json(forecast());
    if (u.host === 'geocoding-api.open-meteo.com') {
      return json({ results: [
        { name: 'Madrid', latitude: 40.4168, longitude: -3.7038, country: 'España', admin1: 'Comunidad de Madrid' },
        { name: 'Majadahonda', latitude: 40.4733, longitude: -3.8722, country: 'España', admin1: 'Comunidad de Madrid' }
      ] });
    }
    if (u.host === 'nominatim.openstreetmap.org') return json({ address: { city: 'Punto del mapa' } });
    if (u.host === 'ipwho.is') return json({ success: true, latitude: 40.4168, longitude: -3.7038, city: 'Madrid' });
    if (u.host === 'ntfy.sh') return json({ id: 'demo', event: 'message' }); // la demo no publica nada
    if (u.host === 'view.eumetsat.int') {
      if (/GetCapabilities/i.test(u.search)) {
        const iso = new Date(lightningLatest()).toISOString().replace('.000', '');
        return new Response(`<WMS_Capabilities><Capability><Layer><Name>li_afa</Name><Dimension name="time" default="${iso}" units="ISO8601">${iso}</Dimension></Layer></Capability></WMS_Capabilities>`,
          { headers: { 'content-type': 'text/xml' } });
      }
      return png(lightningTile(u));
    }
    if (u.host === 'tiles.openfreemap.org' && u.pathname.startsWith('/styles/')) {
      // Estilo mínimo: solo color de fondo (la demo no descarga mapas).
      const dark = u.pathname.includes('dark');
      return json({ version: 8, sources: {}, layers: [{ id: 'fondo', type: 'background', paint: { 'background-color': dark ? '#1b262f' : '#e8ecef' } }] });
    }
    return new Response('mock: sin datos', { status: 404 });
  });
}

module.exports = { install, HOME };
