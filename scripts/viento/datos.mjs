// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Datos del modo «Previsión» de la app y la web (viento, lluvia y temperatura).
 * Lo ejecuta GitHub Actions cada hora (ver .github/workflows/pages.yml) y
 * publica en la web, por modelo:
 *
 *  - viento/<modelo>/index.json: la pasada, la rejilla y la lista de horas
 *    (con el fichero de lluvia y temperatura de cada una, si lo hay).
 *  - viento/<modelo>/<pasada>/fNNN.gz: el viento a 10 m (u, v) y la racha de
 *    cada hora de previsión (formato en src/shared/windgrid.js).
 *  - viento/<modelo>/<pasada>/mNNN.gz: la lluvia media (mm/h) del tramo que
 *    acaba en esa hora y la temperatura a 2 m (formato en src/shared/metgrid.js;
 *    la lluvia sale de la precipitación acumulada del modelo, ver met.mjs). Va
 *    aparte para que los fNNN.gz no cambien.
 *  - viento/<modelo>/orog.gz: la altura del terreno del modelo en su rejilla
 *    (formato en src/shared/metgrid.js), para corregir la temperatura por la
 *    altitud de un punto (Otea). No cambia con la pasada: se copia la ya
 *    publicada y solo se pide a la fuente si falta. Es un añadido: si no se
 *    consigue, el resto se publica igual y `orog` no sale en index.json.
 *
 * Modelos (los tres permiten reutilizar los datos):
 *  - ecmwf: ECMWF IFS 0,25° (CC BY 4.0), de data.ecmwf.int: el índice de cada
 *    fichero dice dónde está cada variable y se piden solo esos trozos. Cada 3 h
 *    hasta +96 h.
 *  - icon-eu: ICON-EU del DWD (CC BY 4.0), 0,0625°, de opendata.dwd.de: un
 *    fichero .bz2 por variable y hora (se descomprime con bzip2). Cada hora hasta
 *    +48 h y cada 3 h hasta +78 h; solo la península y alrededores.
 *  - gfs: GFS 0,25° de NOAA (dominio público), con el filtro de NOMADS, que
 *    recorta Europa y deja solo las variables pedidas. Cada hora hasta +54 h.
 * Los tres salen cuatro veces al día (00, 06, 12 y 18 UTC, unas horas después):
 * si la pasada más reciente ya es la publicada, se copian los ficheros de la
 * web en lugar de volver a pedirlos (y si esa pasada es de antes de que hubiera
 * lluvia y temperatura, solo se piden esas dos variables).
 *
 * Uso: node scripts/viento/datos.mjs <carpeta de salida> [<URL o carpeta con lo publicado>] [<modelo>…]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseGrib2, extract } from './grib2.mjs';
import { pickMet, pickOrog, ratesFromAccumulated } from './met.mjs';

const require = createRequire(import.meta.url);
const W = require('../../src/shared/windgrid.js');
const M = require('../../src/shared/metgrid.js');

const [OUT, PREV, ...ONLY] = process.argv.slice(2);
if (!OUT) { console.error('Uso: node scripts/viento/datos.mjs <salida> [<publicado>] [<modelo>…]'); process.exit(2); }

const CYCLE = 6 * 3600000;
const UA = 'Chubasco (+https://github.com/lalesena/chubasco)';
const range = (a, b, s = 1) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);
const gridOf = (id) => W.MODELS.find((m) => m.id === id).grid;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pad = (n, w = 2) => String(n).padStart(w, '0');
const runId = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`; };
const runTime = (id) => Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10));
const stepFile = (run, h) => `${run}/f${pad(h, 3)}.gz`;
const metFile = (run, h) => `${run}/m${pad(h, 3)}.gz`;
const sameMeta = (meta) => !!meta && JSON.stringify(meta) === JSON.stringify(M.META);
const sameOrog = (meta) => !!meta && JSON.stringify(meta) === JSON.stringify(M.OROG);

async function fetchOk(url, opts = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(120000) });
      if (res.ok || res.status === 404 || i >= tries) return res;
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((r) => setTimeout(r, 3000 * i));
  }
}
const downloaded = new Map(); // servidor → bytes descargados (cada modelo tiene el suyo)
const HOSTS = { gfs: 'nomads.ncep.noaa.gov', ecmwf: 'data.ecmwf.int', 'icon-eu': 'opendata.dwd.de' };
async function bytesOf(url, opts) {
  const res = await fetchOk(url, opts);
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} (${new URL(url).host})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const host = new URL(url).host;
  downloaded.set(host, (downloaded.get(host) || 0) + buf.length);
  return buf;
}

// Como mucho una petición cada `ms` por servidor: los tres piden no abusar.
function limiter(ms) {
  let next = 0;
  return async () => {
    const wait = next - Date.now();
    next = Math.max(next, Date.now()) + ms;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

/** Comprueba que un mensaje es de la pasada y la hora pedidas (la de lluvia acumulada, la de su final). */
const checker = (run, h) => (m) => {
  if (Math.abs(m.hour - h) > 1e-6 || runId(m.refTime) !== run) throw new Error(`se pidió ${run} +${h} h y llegó ${runId(m.refTime)} +${m.hour} h`);
};

/** u, v y racha de una hora, ya recortados a la rejilla del modelo. */
function pickFields(msgs, grid, run, h, { u, v, gust }) {
  const valid = checker(run, h);
  const find = ([num, surface], name) => {
    const m = msgs.find((x) => x.cat === 2 && x.num === num && x.surface === surface);
    if (!m) throw new Error(`falta ${name} a +${h} h`);
    valid(m);
    return extract(m, grid);
  };
  return W.encode({ u: find(u, 'u'), v: find(v, 'v'), gust: gust ? find(gust, 'la racha') : new Float32Array(grid.rows * grid.cols) }, grid);
}
// Código de cada variable en GRIB2: [parámetro de la categoría 2 (viento), tipo de nivel].
const U10 = [2, 103], V10 = [3, 103], GUST10 = [22, 103], GUST_SFC = [22, 1];

// ---------------------------------------------------------------------------
// Modelos

// La lluvia y la temperatura son un añadido: si fallan junto con el viento, el viento se publica igual.
async function soft(want, label, fn) {
  try { return await fn(); } catch (e) {
    if (!want.wind) throw e;
    log(`${label}: sin lluvia ni temperatura (${e.message})`);
    return null;
  }
}
const WANT_ALL = { wind: true, met: true };

const nomads = limiter(1000);
const ecmwf = limiter(150);
const dwd = limiter(100);

// Cada fuente da, de una hora, { wind, met }: el viento ya codificado y la
// temperatura con los acumulados de lluvia (ver met.mjs), según `want`; null si
// la hora aún no está publicada.
const SOURCES = {
  gfs: {
    hours: range(0, 54),
    concurrency: 3,
    async step(run, h, grid, want) {
      const day = run.slice(0, 8), hh = run.slice(8, 10);
      const d = W.DOMAIN;
      const q = new URLSearchParams({ dir: `/gfs.${day}/${hh}/atmos`, file: `gfs.t${hh}z.pgrb2.0p25.f${pad(h, 3)}` });
      // La temperatura a 2 m y la lluvia acumulada (no hay a +0 h) van en la misma petición que el viento.
      // lev_surface es para la racha y la lluvia (con la temperatura a 2 m llega también la del suelo, que no se usa).
      if (want.wind) for (const k of ['var_UGRD', 'var_VGRD', 'var_GUST', 'lev_10_m_above_ground', 'lev_surface']) q.set(k, 'on');
      if (want.met) {
        q.set('var_TMP', 'on');
        q.set('lev_2_m_above_ground', 'on');
        if (h > 0) { q.set('var_APCP', 'on'); q.set('lev_surface', 'on'); }
      }
      for (const [k, v] of Object.entries({ subregion: '', toplat: d.north, leftlon: d.west, rightlon: d.east, bottomlat: d.south })) q.set(k, String(v));
      await nomads();
      const buf = await bytesOf(`https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?${q}`);
      if (!buf) return null;
      const msgs = parseGrib2(buf);
      return {
        wind: want.wind ? pickFields(msgs, grid, run, h, { u: U10, v: V10, gust: GUST_SFC }) : null,
        met: want.met ? await soft(want, `gfs +${h} h`, () => pickMet(msgs, 'gfs', grid, h, checker(run, h))) : null
      };
    }
  },
  ecmwf: {
    hours: range(0, 96, 3),
    concurrency: 3,
    async step(run, h, grid, want) {
      const day = run.slice(0, 8), hh = run.slice(8, 10);
      const base = `https://data.ecmwf.int/forecasts/${day}/${hh}z/ifs/0p25/oper/${day}${hh}0000-${h}h-oper-fc`;
      await ecmwf();
      const idx = await bytesOf(`${base}.index`);
      if (!idx) return null;
      // Una línea JSON por campo, con su posición en el .grib2.
      const fields = new Map();
      for (const line of new TextDecoder().decode(idx).split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.levtype === 'sfc' && ['10u', '10v', '10fg', '10fg3', '10fg6', '2t', 'tp'].includes(e.param)) fields.set(e.param, e);
      }
      const grab = async (params) => {
        const parts = [];
        for (const p of params) {
          const e = fields.get(p);
          if (!e) throw new Error(`ECMWF +${h} h: falta ${p}`);
          await ecmwf();
          const b = await bytesOf(`${base}.grib2`, { headers: { Range: `bytes=${e._offset}-${e._offset + e._length - 1}` } });
          if (!b || b.length !== e._length) throw new Error(`ECMWF +${h} h: ${p} incompleto`);
          parts.push(...parseGrib2(b));
        }
        return parts;
      };
      // La racha es la máxima de la última hora (10fg; desde +93 h, de las últimas 3: 10fg3). A +0 h no hay.
      const gust = ['10fg', '10fg3', '10fg6'].find((p) => fields.has(p));
      return {
        wind: want.wind ? pickFields(await grab(h > 0 ? ['10u', '10v', gust || '10fg'] : ['10u', '10v']), grid, run, h, { u: U10, v: V10, gust: h > 0 ? GUST10 : null }) : null,
        // tp (en m) es el acumulado desde la pasada; a +0 h no se pide.
        met: want.met ? await soft(want, `ecmwf +${h} h`, async () => pickMet(await grab(h > 0 ? ['2t', 'tp'] : ['2t']), 'ecmwf', grid, h, checker(run, h))) : null
      };
    }
  },
  'icon-eu': {
    hours: [...range(0, 48), ...range(51, 78, 3)],
    concurrency: 4,
    async step(run, h, grid, want) {
      const hh = run.slice(8, 10);
      const get = async (v) => {
        await dwd();
        const bz = await bytesOf(`https://opendata.dwd.de/weather/nwp/icon-eu/grib/${hh}/${v.toLowerCase()}/icon-eu_europe_regular-lat-lon_single-level_${run}_${pad(h, 3)}_${v}.grib2.bz2`);
        if (!bz) return null;
        const out = spawnSync('bzip2', ['-dc'], { input: bz, maxBuffer: 64 * 1024 * 1024 });
        if (out.status !== 0) throw new Error(`bzip2: ${out.error ? out.error.message : String(out.stderr).trim()}`);
        return parseGrib2(out.stdout);
      };
      let wind = null;
      if (want.wind) {
        const msgs = [];
        for (const v of ['U_10M', 'V_10M', 'VMAX_10M']) {
          const m = await get(v);
          if (!m) return null;
          msgs.push(...m);
        }
        wind = pickFields(msgs, grid, run, h, { u: U10, v: V10, gust: GUST10 });
      }
      // TOT_PREC (en mm) es el acumulado desde la pasada; a +0 h no existe.
      const met = want.met ? await soft(want, `icon-eu +${h} h`, async () => {
        const msgs = [];
        for (const v of h > 0 ? ['T_2M', 'TOT_PREC'] : ['T_2M']) {
          const m = await get(v);
          if (!m) throw new Error(`falta ${v}`);
          msgs.push(...m);
        }
        return pickMet(msgs, 'icon-eu', grid, h, checker(run, h));
      }) : null;
      return { wind, met };
    }
  }
};

// ---------------------------------------------------------------------------
// Altura del terreno de cada modelo (una vez; ver met.mjs/pickOrog). Devuelve los mensajes GRIB2 del fichero.

const OROG = {
  // HGT en superficie de la hora 0, con el mismo filtro de NOMADS que el resto.
  async gfs(run) {
    const day = run.slice(0, 8), hh = run.slice(8, 10), d = W.DOMAIN;
    const q = new URLSearchParams({ dir: `/gfs.${day}/${hh}/atmos`, file: `gfs.t${hh}z.pgrb2.0p25.f000`, var_HGT: 'on', lev_surface: 'on' });
    for (const [k, v] of Object.entries({ subregion: '', toplat: d.north, leftlon: d.west, rightlon: d.east, bottomlat: d.south })) q.set(k, String(v));
    await nomads();
    const buf = await bytesOf(`https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?${q}`);
    if (!buf) throw new Error('GFS: no está la hora 0');
    return parseGrib2(buf);
  },
  // El geopotencial en superficie (z) viene en el .grib2 de la hora 0, y el índice dice dónde.
  async ecmwf(run) {
    const day = run.slice(0, 8), hh = run.slice(8, 10);
    const base = `https://data.ecmwf.int/forecasts/${day}/${hh}z/ifs/0p25/oper/${day}${hh}0000-0h-oper-fc`;
    await ecmwf();
    const idx = await bytesOf(`${base}.index`);
    if (!idx) throw new Error('ECMWF: no está la hora 0');
    const z = new TextDecoder().decode(idx).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).find((e) => e.levtype === 'sfc' && e.param === 'z');
    if (!z) throw new Error('ECMWF: falta z en la hora 0');
    await ecmwf();
    const b = await bytesOf(`${base}.grib2`, { headers: { Range: `bytes=${z._offset}-${z._offset + z._length - 1}` } });
    if (!b || b.length !== z._length) throw new Error('ECMWF: z incompleto');
    return parseGrib2(b);
  },
  // HSURF es un fichero «invariante en el tiempo» por carpeta de pasada, y el DWD lo renueva poco: se lee el nombre del listado.
  async 'icon-eu'(run) {
    const dir = `https://opendata.dwd.de/weather/nwp/icon-eu/grib/${run.slice(8, 10)}/hsurf/`;
    await dwd();
    const list = await bytesOf(dir);
    const name = list && [...new TextDecoder().decode(list).matchAll(/href="([^"]*_HSURF\.grib2\.bz2)"/g)].map((m) => m[1]).sort().pop();
    if (!name) throw new Error('ICON-EU: no está HSURF');
    await dwd();
    const bz = await bytesOf(dir + name);
    if (!bz) throw new Error('ICON-EU: no está HSURF');
    const out = spawnSync('bzip2', ['-dc'], { input: bz, maxBuffer: 64 * 1024 * 1024 });
    if (out.status !== 0) throw new Error(`bzip2: ${out.error ? out.error.message : String(out.stderr).trim()}`);
    return parseGrib2(out.stdout);
  }
};

/** Recoge las horas pedidas de una pasada, con varias peticiones a la vez, en `steps` (hora → resultado). */
async function collect(id, run, hours, want, steps) {
  const src = SOURCES[id], grid = gridOf(id);
  const todo = [...hours];
  const worker = async () => {
    while (todo.length) {
      const h = todo.shift();
      try {
        const s = await src.step(run, h, grid, want);
        if (s) steps.set(h, s);
      } catch (e) { log(`${id} +${h} h:`, e.message); }
    }
  };
  await Promise.all(Array.from({ length: src.concurrency }, worker));
}

/**
 * Lluvia y temperatura de cada hora en su formato publicado. `steps`:
 * [[h, { wind, raw }]] con raw = { temp, acc } (pickMet) o null si no hay.
 * Devuelve [[h, { wind, met, span }]] con `met` ya codificado (o null).
 */
function finishMet(grid, steps) {
  const rates = ratesFromAccumulated(steps.filter(([, s]) => s.raw).map(([h, s]) => ({ h, acc: s.raw.acc })), grid.rows * grid.cols);
  const byHour = new Map(rates.map((r) => [r.h, r]));
  return steps.map(([h, s]) => {
    const r = s.raw && byHour.get(h);
    return [h, { wind: s.wind, met: r ? M.encode({ rain: r.rate, temp: s.raw.temp }, grid) : null, span: r ? r.span : 0 }];
  });
}

async function fromSource(id, run) {
  const src = SOURCES[id], grid = gridOf(id);
  // Primero la última hora: si no está, la pasada aún se está publicando.
  const lastH = src.hours[src.hours.length - 1];
  const last = await src.step(run, lastH, grid, WANT_ALL);
  if (!last) return null;
  const steps = new Map([[lastH, last]]);
  await collect(id, run, src.hours.slice(0, -1), WANT_ALL, steps);
  // Solo horas seguidas desde el principio (un hueco en medio rompería la animación).
  const out = [];
  for (const h of src.hours) { if (!steps.has(h)) break; out.push([h, { wind: steps.get(h).wind, raw: steps.get(h).met }]); }
  if (out.length < Math.ceil(src.hours.length / 2)) throw new Error(`${run}: solo ${out.length} horas seguidas`);
  return finishMet(grid, out);
}

/** A una pasada ya publicada sin lluvia ni temperatura, se le piden solo esas variables. */
async function addMet(id, run, steps) {
  const got = new Map();
  await collect(id, run, steps.map(([h]) => h), { wind: false, met: true }, got);
  return finishMet(gridOf(id), steps.map(([h, s]) => [h, { wind: s.wind, raw: got.has(h) ? got.get(h).met : null }]));
}

// ---------------------------------------------------------------------------
// Lo ya publicado (URL de la web o carpeta)

async function readPrev(file) {
  if (!PREV) return null;
  try {
    if (/^https?:\/\//.test(PREV)) {
      const res = await fetchOk(`${PREV.replace(/\/+$/, '')}/${file}`);
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    }
    return await fs.readFile(path.join(PREV, file));
  } catch (e) {
    return null;
  }
}

async function fromPrev(id, index) {
  const out = [];
  const hasMet = sameMeta(index.met);
  for (const s of index.steps) {
    const gz = await readPrev(`${id}/${s.f}`);
    if (!gz) throw new Error(`falta ${id}/${s.f} en lo publicado`);
    const raw = gunzipSync(gz);
    W.decode(raw, index.grid); // comprueba el tamaño
    let met = null;
    if (hasMet && s.m) {
      const mz = await readPrev(`${id}/${s.m}`);
      if (mz) { met = gunzipSync(mz); M.decode(met, index.grid); }
    }
    out.push([s.h, { wind: raw, met, span: met ? s.span || 0 : 0 }]);
  }
  return out;
}

// ---------------------------------------------------------------------------

/** La altura del terreno ya publicada (gz) si sirve; si no, se pide a la fuente. null si no se consigue (es un añadido). */
async function orogOf(id, run, grid, published) {
  if (published && published.orog === 'orog.gz' && sameOrog(published.orogMeta)) {
    const gz = await readPrev(`${id}/orog.gz`);
    if (gz) {
      try { M.decodeOrog(gunzipSync(gz), grid); log(`${id}: altura del terreno copiada de lo publicado`); return gz; } catch (e) { log(`${id}: la altura del terreno publicada no vale (${e.message})`); }
    }
  }
  try {
    const gz = gzipSync(M.encodeOrog(pickOrog(await OROG[id](run), id, grid), grid), { level: 9 });
    log(`${id}: altura del terreno pedida a la fuente`);
    return gz;
  } catch (e) {
    log(`${id}: sin altura del terreno (${e.message})`);
    return null;
  }
}

async function model(id) {
  const grid = gridOf(id);
  const t0 = Date.now();
  let prev = null;
  try { prev = JSON.parse(await readPrev(`${id}/index.json`)); } catch (e) { prev = null; }
  if (prev && (prev.v !== 1 || prev.model !== id || JSON.stringify(prev.grid) !== JSON.stringify(grid))) prev = null; // otro formato o rejilla
  const published = prev;
  log(`${id}: publicado ${prev ? prev.run : 'nada'}`);

  // Pasadas candidatas, de la más reciente a la de hace un día.
  const latest = Math.floor(Date.now() / CYCLE) * CYCLE;
  let run = null, steps = null, reused = null;
  for (const r of [0, 1, 2, 3, 4].map((k) => runId(latest - k * CYCLE))) {
    if (prev && r === prev.run) {
      try { steps = await fromPrev(id, prev); run = r; reused = prev; log(`${id} ${r}: copiada de lo publicado`); break; } catch (e) { log(`${id} ${r}:`, e.message); }
    }
    if (prev && runTime(r) < runTime(prev.run)) {
      // Más antigua que la publicada: mejor seguir con aquella si la fuente falla.
      try { steps = await fromPrev(id, prev); run = prev.run; reused = prev; log(`${id} ${prev.run}: se mantiene la publicada`); break; } catch (e) { log(`${id} ${prev.run}:`, e.message); prev = null; }
    }
    try {
      steps = await fromSource(id, r);
      if (steps) { run = r; log(`${id} ${r}: ${steps.length} horas nuevas`); break; }
      log(`${id} ${r}: aún no está completa`);
    } catch (e) {
      log(`${id} ${r}:`, e.message);
    }
  }
  if (!run) throw new Error(`${id}: no hay ninguna pasada disponible`);
  // Una pasada publicada antes de que hubiera lluvia y temperatura: se completa (si la fuente falla, se queda como estaba).
  if (reused && !sameMeta(reused.met)) {
    try { steps = await addMet(id, run, steps); log(`${id} ${run}: lluvia y temperatura de ${steps.filter(([, s]) => s.met).length} horas`); } catch (e) { log(`${id} ${run}: sin lluvia ni temperatura (${e.message})`); }
  }

  const orog = await orogOf(id, run, grid, published);
  const dir = path.join(OUT, id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, run), { recursive: true });
  const rt = runTime(run);
  const list = [];
  let bytes = 0, metBytes = 0;
  for (const [h, s] of steps) {
    const gz = gzipSync(s.wind, { level: 9 });
    bytes += gz.length;
    await fs.writeFile(path.join(dir, stepFile(run, h)), gz);
    const e = { h, t: rt + h * 3600000, f: stepFile(run, h) };
    if (s.met) {
      const mz = gzipSync(s.met, { level: 9 });
      metBytes += mz.length;
      await fs.writeFile(path.join(dir, metFile(run, h)), mz);
      e.m = metFile(run, h);
      if (s.span) e.span = s.span; // horas del tramo de lluvia que acaba en esta hora
    }
    list.push(e);
  }
  if (orog) await fs.writeFile(path.join(dir, 'orog.gz'), orog);
  const withMet = list.some((e) => e.m);
  const index = { v: 1, model: id, run, runTime: rt, generated: Date.now(), grid, scale: W.SCALE, ...(withMet ? { met: M.META } : {}), ...(orog ? { orog: 'orog.gz', orogMeta: M.OROG } : {}), steps: list };
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
  const mb = (downloaded.get(HOSTS[id]) || 0) / 1e6;
  log(`${id}: ${run}, ${list.length} horas, ${orog ? `terreno ${(orog.length / 1e3).toFixed(0)} kB, ` : 'sin altura del terreno, '}viento ${(bytes / 1e6).toFixed(1)} MB y lluvia y temperatura ${(metBytes / 1e6).toFixed(1)} MB (${list.filter((e) => e.m).length} horas); descargados ${mb.toFixed(0)} MB en ${Math.round((Date.now() - t0) / 1000)} s`);
}

// Cada modelo por su cuenta: si uno falla, los demás se publican igual.
const ids = ONLY.length ? ONLY : W.MODELS.map((m) => m.id);
const results = await Promise.allSettled(ids.map(model));
let failed = 0;
results.forEach((r, i) => { if (r.status === 'rejected') { failed++; console.error(`${ids[i]}:`, r.reason && r.reason.message); } });
process.exit(failed ? 1 : 0);
