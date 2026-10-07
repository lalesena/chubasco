'use strict';
/*
 * Modo demostración (CHUBASCO_MOCK=1 / `npm run demo`): intercepta las
 * peticiones HTTPS y sirve datos sintéticos — una línea de tormentas que
 * avanza hacia Madrid — para probar la interfaz y las alarmas sin red.
 */
const { protocol } = require('electron');
const { PNG } = require('pngjs');
const P = require('../shared/palette');

const HOME = { lat: 40.4168, lon: -3.7038 };
const STEP = 600; // 10 min

const rainColors = new Map();
for (const e of P._table) if (e.kind === P.KIND_RAIN && !rainColors.has(e.dbz)) rainColors.set(e.dbz, e.rgba);

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

function radarTile(time, size, z, x, y) {
  const png = new PNG({ width: size, height: size });
  const world = size * Math.pow(2, z);
  const nowS = Math.floor(Date.now() / 1000);
  const tMin = (time - nowS) / 60;
  const cosLat = Math.cos((HOME.lat * Math.PI) / 180);
  for (let py = 0; py < size; py++) {
    const gy = y * size + py;
    const lat = (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * gy) / world)) * 180) / Math.PI;
    const kmy = (lat - HOME.lat) * 111.2;
    for (let px = 0; px < size; px++) {
      const gx = x * size + px;
      const lon = (gx / world) * 360 - 180;
      const kmx = (lon - HOME.lon) * 111.2 * cosLat;
      const v = dbzAt(kmx, kmy, tMin);
      if (v < 10) continue;
      const c = rainColors.get(Math.max(10, Math.min(65, Math.round(v))));
      const o = (py * size + px) * 4;
      png.data[o] = c[0]; png.data[o + 1] = c[1]; png.data[o + 2] = c[2]; png.data[o + 3] = c[3];
    }
  }
  return PNG.sync.write(png);
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

function plainTile(dark, size = 256) {
  const png = new PNG({ width: size, height: size });
  const bg = dark ? [27, 38, 47] : [232, 236, 239];
  const ln = dark ? [40, 54, 66] : [214, 221, 226];
  for (let i = 0; i < size * size; i++) {
    const px = i % size, py = Math.floor(i / size);
    const c = px % 64 === 0 || py % 64 === 0 ? ln : bg;
    png.data[i * 4] = c[0]; png.data[i * 4 + 1] = c[1]; png.data[i * 4 + 2] = c[2]; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function emptyTile(size = 256) {
  return PNG.sync.write(new PNG({ width: size, height: size }));
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
    if (u.host === 'api.rainviewer.com') {
      const now = Math.floor(Date.now() / 1000);
      const last = now - (now % STEP) - STEP;
      const past = [];
      for (let i = 12; i >= 0; i--) past.push({ time: last - i * STEP, path: `/v2/radar/${last - i * STEP}` });
      return json({ version: '2.0', generated: now, host: 'https://tilecache.rainviewer.com', radar: { past, nowcast: [] }, satellite: { infrared: [] } });
    }
    if (u.host === 'tilecache.rainviewer.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[1] === 'coverage') return png(emptyTile(512));
      // v2 radar {time} {size} {z} {x} {y} {color} {opts}.png
      const [, , time, size, z, x, y] = parts;
      return png(radarTile(Number(time), Number(size), Number(z), Number(x), Number(y)));
    }
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
