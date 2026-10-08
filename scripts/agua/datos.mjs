// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Datos de agua de España para la app y la web. Lo ejecuta GitHub Actions
 * cada hora (ver .github/workflows/pages.yml) y publica en la web:
 *
 *  - agua.json:   lo que leen la app y la web.
 *  - embalses/<cuenca>.json: histórico de cada embalse (la ficha lo pide al abrirse).
 *  - pluvio.json: lluvia medida en los pluviómetros de AEMET (resumen), y
 *    pluvio/<estación>.json con todas sus series; pluvio/archivo.json.gz es
 *    el estado de los pluviómetros (ver pluvio.mjs).
 *  - estado.json: lo necesario para la siguiente ejecución (lluvia por horas
 *                 y por días); se recupera de la web publicada.
 *
 * Fuentes (las dos permiten reutilizar los datos citándolas):
 *  - Lluvia: radar EUMETNET OPERA, acumulación horaria (ACRR, 2 km), CC BY 4.0.
 *    Las últimas horas, del GeoTIFF del almacén de 24 h (solo los mosaicos
 *    de la península); los días que falten, del archivo (HDF5).
 *  - Embalses: MITECO, Boletín Hidrológico semanal (BD-Embalses), que se
 *    descarga solo cuando cambia (los martes).
 *  - Pluviómetros: AEMET OpenData, observación horaria de las estaciones
 *    automáticas (últimas 12 horas) y valores climatológicos diarios. Necesita
 *    la clave en AEMET_API_KEY (secreto de GitHub).
 *
 * Uso: node scripts/agua/datos.mjs <carpeta de salida> [<URL o carpeta con el estado anterior>]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import MDBReader from 'mdb-reader';
import * as hdf5 from 'jsfive';
import { gzipSync, gunzipSync } from 'node:zlib';
import { GRID, buildMasks, basinHour, sumHours, hydroYearStart, summarizeReservoirs, reservoirHistory } from './lib.mjs';
import * as P from './pluvio.mjs';

const require = createRequire(import.meta.url);
const TIFF = require('../../src/main/tiff.js');
const CUENCAS = require('../../src/shared/cuencas.js');

const [OUT, PREV] = process.argv.slice(2);
if (!OUT) { console.error('Uso: node scripts/agua/datos.mjs <salida> [<estado anterior>]'); process.exit(2); }

const S3 = 'https://s3.waw3-1.cloudferro.com';
const EMBALSES_URL = 'https://www.miteco.gob.es/content/dam/miteco/es/agua/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico/Historico-de-embalses/BD-Embalses.zip';
const HOUR = 3600;
const KEEP_HOURS = 48;
const MAX_NEW_DAYS = Number(process.env.AGUA_MAX_DAYS) || 8; // días del archivo por ejecución (la primera tarda)
const NODATA = -9999000, UNDETECT_H5 = -8888000;


const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pad = (n) => String(n).padStart(2, '0');
const hourKey = (t) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`; };
const dayKey = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const dayStart = (key) => Date.parse(key + 'T00:00:00Z') / 1000;
const round1 = (v) => Math.round(v * 10) / 10;

const UA = 'Chubasco (+https://github.com/lalesena/chubasco)';

async function fetchOk(url, opts = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(120000) });
      if (res.ok || res.status === 404 || i >= tries) return res;
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000 * i));
  }
}

// ---------------------------------------------------------------------------
// Lluvia de una hora (la que termina en t), como función píxel → mm (NaN sin datos).

function acrrUrl(bucket, t, ext) {
  const d = new Date(t * 1000);
  const Y = d.getUTCFullYear(), M = pad(d.getUTCMonth() + 1), D = pad(d.getUTCDate());
  return `${S3}/${bucket}/${Y}/${M}/${D}/OPERA/COMP/OPERA@${Y}${M}${D}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}@0@ACRR.${ext}`;
}

async function rangeGet(url, start, end) {
  const res = await fetchOk(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return res.status === 206 ? buf : buf.subarray(start, end + 1);
}

// Del GeoTIFF del almacén de 24 h: solo los mosaicos de la ventana.
async function hourFromTiff(t, win) {
  const url = acrrUrl('openradar-24h', t, 'tiff');
  const head = await rangeGet(url, 0, 32767);
  if (!head) return null;
  const h = TIFF.parseHeader(head);
  const ifd = h.ifds[0];
  if (ifd.width !== GRID.width || ifd.height !== GRID.height || Math.round(h.geo.pixelX) !== GRID.size) throw new Error('Rejilla ACRR inesperada');
  const tiles = new Map();
  for (let ty = Math.floor(win.r0 / ifd.tileHeight); ty <= Math.floor(win.r1 / ifd.tileHeight); ty++) {
    for (let tx = Math.floor(win.c0 / ifd.tileWidth); tx <= Math.floor(win.c1 / ifd.tileWidth); tx++) {
      const k = ty * ifd.tilesAcross + tx;
      const off = ifd.tileOffsets[k], len = ifd.tileByteCounts[k];
      const bytes = len ? await rangeGet(url, off, off + len - 1) : null;
      tiles.set(k, bytes ? await TIFF.decodeTile(ifd, bytes) : null);
    }
  }
  return (i) => {
    const r = Math.floor(i / GRID.width), c = i % GRID.width;
    const tile = tiles.get(Math.floor(r / ifd.tileHeight) * ifd.tilesAcross + Math.floor(c / ifd.tileWidth));
    if (!tile) return NaN;
    const v = tile[(r % ifd.tileHeight) * ifd.tileWidth + (c % ifd.tileWidth)];
    if (Number.isNaN(v)) return 0; // medido, sin lluvia
    return v <= -1e5 ? NaN : Math.max(0, v);
  };
}

// Del archivo (HDF5 de toda Europa).
async function hourFromH5(t) {
  const res = await fetchOk(acrrUrl('openradar-archive', t, 'h5'));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const f = new hdf5.File(buf, 'acrr.h5');
  const where = f.get('where').attrs;
  if (where.xsize !== GRID.width || where.ysize !== GRID.height || where.xscale !== GRID.size) throw new Error('Rejilla ACRR inesperada (HDF5)');
  const what = f.get('dataset1/data1/what').attrs;
  const gain = what.gain ?? 1, offset = what.offset ?? 0;
  const data = f.get('dataset1/data1/data').value;
  return (i) => {
    const v = data[i];
    if (v === (what.undetect ?? UNDETECT_H5)) return 0;
    if (v === (what.nodata ?? NODATA) || !(v > -1e5)) return NaN;
    return Math.max(0, v * gain + offset);
  };
}

async function rainfall(state, masks, now) {
  // 1. Horas recientes (las que terminan en punto), del GeoTIFF.
  const hours = { ...(state.hours || {}) };
  const latest = Math.floor((now - 20 * 60) / HOUR) * HOUR; // ~20 min de retraso
  for (let t = latest; t > latest - KEEP_HOURS * HOUR; t -= HOUR) {
    const k = hourKey(t);
    if (hours[k] && t < latest - 2 * HOUR) continue; // las tres últimas se repasan por si llegaron tarde
    try {
      const get = (await hourFromTiff(t, masks.window)) || (await hourFromH5(t));
      if (get) { hours[k] = basinHour(get, masks); log('hora', k); }
    } catch (e) { log('hora', k, e.message); }
  }
  for (const k of Object.keys(hours)) if (k < hourKey(latest - KEEP_HOURS * HOUR)) delete hours[k];

  // 2. Días completos (UTC): con las horas guardadas o, si faltan, del archivo.
  const days = { ...(state.days || {}) };
  const today = dayKey(now);
  const hydroStart = hydroYearStart(now);
  const firstDay = Math.min(dayStart(hydroStart), dayStart(today) - 31 * 86400);
  let fromArchive = 0;
  for (let d = dayStart(today) - 86400; d >= firstDay; d -= 86400) {
    const k = dayKey(d);
    if (days[k]) continue;
    const hourly = [];
    for (let h = 1; h <= 24; h++) hourly.push(hours[hourKey(d + h * HOUR)] || null);
    if (hourly.some((x) => !x)) {
      if (fromArchive >= MAX_NEW_DAYS) continue;
      fromArchive++;
      log('día del archivo', k);
      for (let h = 0; h < 24; h++) {
        if (hourly[h]) continue;
        try {
          const get = await hourFromH5(d + (h + 1) * HOUR);
          if (get) hourly[h] = basinHour(get, masks);
        } catch (e) { log('archivo', k, h, e.message); }
      }
    }
    const got = hourly.filter(Boolean);
    if (got.length < 22) { log('día incompleto', k, got.length); continue; }
    days[k] = sumHours(got, 24 / got.length, CUENCAS.basins);
  }
  for (const k of Object.keys(days)) if (dayStart(k) < firstDay) delete days[k];

  // 3. Resúmenes por cuenca.
  const latestKey = Object.keys(hours).sort().pop();
  const last24 = [];
  const todayHours = [];
  for (let h = 0; h < 24; h++) {
    const t = latest - h * HOUR;
    const x = hours[hourKey(t)];
    if (x) { last24.push(x); if (t > dayStart(today)) todayHours.push(x); }
  }
  const h24 = last24.length >= 20 ? sumHours(last24, 24 / last24.length, CUENCAS.basins) : null;
  const hoy = todayHours.length ? sumHours(todayHours, 1, CUENCAS.basins) : {};
  const sumDays = (from) => {
    const out = {};
    for (const b of CUENCAS.basins) {
      let mm = hoy[b.id] ? hoy[b.id][0] || 0 : 0, n = 0, need = 0;
      for (let d = dayStart(today) - 86400; d >= from; d -= 86400) {
        need++;
        const v = days[dayKey(d)] && days[dayKey(d)][b.id];
        if (v && v[0] !== null) { mm += v[0]; n++; }
      }
      out[b.id] = n >= need * 0.9 ? round1(mm) : null;
    }
    return out;
  };
  const d7 = sumDays(dayStart(today) - 6 * 86400);
  const d30 = sumDays(dayStart(today) - 29 * 86400);
  const year = sumDays(dayStart(hydroStart));
  const basins = {};
  for (const b of CUENCAS.basins) {
    const serie = [];
    for (let d = dayStart(today) - 29 * 86400; d < dayStart(today); d += 86400) {
      const v = days[dayKey(d)] && days[dayKey(d)][b.id];
      serie.push(v && v[0] !== null ? round1(v[0]) : null);
    }
    serie.push(hoy[b.id] && hoy[b.id][0] !== null ? round1(hoy[b.id][0]) : null);
    basins[b.id] = {
      h24: h24 && h24[b.id][0] !== null ? round1(h24[b.id][0]) : null,
      d7: d7[b.id], d30: d30[b.id], year: year[b.id],
      cover: h24 ? h24[b.id][1] : null,
      serie
    };
  }
  return {
    state: { hours, days },
    out: { until: latestKey ? new Date(Date.UTC(+latestKey.slice(0, 4), +latestKey.slice(4, 6) - 1, +latestKey.slice(6, 8), +latestKey.slice(8, 10))).toISOString() : null, hydroYearStart: hydroStart, basins }
  };
}

// ---------------------------------------------------------------------------
// Embalses

async function reservoirs(state) {
  const head = await fetchOk(EMBALSES_URL, { method: 'HEAD' });
  if (!head.ok) throw new Error(`MITECO HTTP ${head.status}`);
  const lastModified = head.headers.get('last-modified') || '';
  if (state.embalses && state.embalses.lastModified === lastModified && state.embalses.out && state.embalses.hist) {
    log('embalses: sin cambios', lastModified);
    return state.embalses;
  }
  log('embalses: descargando', lastModified);
  const res = await fetchOk(EMBALSES_URL);
  if (!res.ok) throw new Error(`MITECO HTTP ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const name = Object.keys(files).find((f) => /\.mdb$/i.test(f));
  if (!name) throw new Error('BD-Embalses sin .mdb');
  const db = new MDBReader(Buffer.from(files[name].buffer, files[name].byteOffset, files[name].byteLength));
  const rows = db.getTable(db.getTableNames()[0]).getData();
  log('embalses: filas', rows.length);

  const out = summarizeReservoirs(rows, CUENCAS.basins, log);
  log('embalses:', out.date, `${out.total.pct} %`);
  return { lastModified, out, hist: reservoirHistory(rows, CUENCAS.basins) };
}

// ---------------------------------------------------------------------------
// Pluviómetros (AEMET OpenData): dos pasos, la respuesta da la URL de los datos.

const AEMET = 'https://opendata.aemet.es/opendata/api/';

async function aemet(pathname, key) {
  const res = await fetchOk(AEMET + pathname, { headers: { api_key: key } });
  if (!res.ok) throw new Error(`AEMET HTTP ${res.status}`);
  const env = await res.json();
  if (env.estado === 404) return []; // «No hay datos que satisfagan esos criterios»
  if (env.estado !== 200 || !env.datos) throw new Error(`AEMET ${env.estado} ${env.descripcion || ''}`);
  const data = await fetchOk(env.datos);
  if (!data.ok) throw new Error(`AEMET datos HTTP ${data.status}`);
  return JSON.parse(new TextDecoder('iso-8859-15').decode(await data.arrayBuffer()));
}

async function gauges(arch, now) {
  const key = process.env.AEMET_API_KEY;
  if (!key) { log('pluviómetros: sin AEMET_API_KEY'); return arch; }
  const ms = now * 1000;
  const rows = await aemet('observacion/convencional/todas', key);
  P.ingestHourly(arch, rows, ms);
  log('pluviómetros: observación,', rows.length, 'filas');
  // Valores diarios: los últimos días y, poco a poco, hacia atrás.
  for (const chunk of P.planDaily(arch, ms, { maxBack: Number(process.env.AEMET_MAX_CHUNKS) || 6 })) {
    try {
      const daily = await aemet(`valores/climatologicos/diarios/datos/fechaini/${chunk.from}T00:00:00UTC/fechafin/${chunk.to}T23:59:59UTC/todasestaciones`, key);
      P.ingestDaily(arch, daily, ms);
      P.markFetched(arch, chunk, ms);
      log('pluviómetros: días', chunk.from, chunk.to, daily.length, 'filas');
    } catch (e) { log('pluviómetros: días', chunk.from, chunk.to, e.message); break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return arch;
}

async function readArchive() {
  if (!PREV) return null;
  try {
    let buf;
    if (/^https?:/.test(PREV)) {
      const res = await fetchOk(PREV.replace(/\/+$/, '') + '/pluvio/archivo.json.gz');
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      buf = await fs.readFile(path.join(PREV, 'pluvio', 'archivo.json.gz'));
    }
    return JSON.parse(gunzipSync(buf).toString('utf8'));
  } catch (e) {
    log('archivo de pluviómetros:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------

async function readPrevious() {
  if (!PREV) return {};
  try {
    if (/^https?:/.test(PREV)) {
      const res = await fetchOk(PREV.replace(/\/+$/, '') + '/estado.json');
      return res.ok ? await res.json() : {};
    }
    return JSON.parse(await fs.readFile(path.join(PREV, 'estado.json'), 'utf8'));
  } catch (e) {
    log('estado anterior:', e.message);
    return {};
  }
}

const now = Math.floor(Date.now() / 1000);
const prev = await readPrevious();
const state = { version: 2, rain: prev.rain || {}, embalses: prev.embalses || null };
let archive = (await readArchive()) || P.emptyArchive();
const masks = buildMasks(CUENCAS.basins);
log('máscaras', masks.basins.map((b) => `${b.id}:${b.pixels.length}`).join(' '));

// Lo que falle se anota en agua.json (y se conservan los datos anteriores).
const errors = {};
let lluvia = null;
try {
  const r = await rainfall(state.rain, masks, now);
  state.rain = r.state;
  lluvia = r.out;
} catch (e) { log('lluvia:', e.stack || e.message); errors.rain = String(e.message || e); }

try {
  state.embalses = await reservoirs(state);
} catch (e) { log('embalses:', e.stack || e.message); errors.reservoirs = String((e.cause && e.cause.code) || e.message || e); }

try {
  archive = await gauges(archive, now);
} catch (e) { log('pluviómetros:', e.stack || e.message); errors.gauges = String((e.cause && e.cause.code) || e.message || e); }
const pluvio = P.summarize(archive, now * 1000);

const agua = {
  updated: new Date(now * 1000).toISOString(),
  sources: {
    rain: 'EUMETNET OPERA (CC BY 4.0), estimación por radar',
    reservoirs: 'MITECO – Boletín Hidrológico semanal',
    basins: CUENCAS.attribution,
    gauges: '© AEMET (información elaborada por la Agencia Estatal de Meteorología)'
  },
  rain: lluvia,
  reservoirs: state.embalses ? state.embalses.out : null,
  errors: Object.keys(errors).length ? errors : undefined
};
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'agua.json'), JSON.stringify(agua));
await fs.writeFile(path.join(OUT, 'estado.json'), JSON.stringify(state));
if (archive.hourly) {
  await fs.mkdir(path.join(OUT, 'pluvio'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'pluvio', 'archivo.json.gz'), gzipSync(JSON.stringify(archive)));
}
if (pluvio) {
  await fs.writeFile(path.join(OUT, 'pluvio.json'), JSON.stringify({ source: agua.sources.gauges, ...pluvio }));
  for (const row of pluvio.stations) await fs.writeFile(path.join(OUT, 'pluvio', `${row[0]}.json`), JSON.stringify({ source: agua.sources.gauges, ...P.stationFile(archive, row[0], row) }));
  log('pluviómetros:', pluvio.stations.length, 'estaciones publicadas');
}
if (state.embalses && state.embalses.hist) {
  await fs.mkdir(path.join(OUT, 'embalses'), { recursive: true });
  for (const [id, h] of Object.entries(state.embalses.hist)) await fs.writeFile(path.join(OUT, 'embalses', `${id}.json`), JSON.stringify(h));
}
log('escrito', OUT, `${(JSON.stringify(agua).length / 1024).toFixed(0)} KB`);
