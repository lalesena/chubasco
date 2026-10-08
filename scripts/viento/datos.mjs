// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Viento para el modo «Viento» de la app y la web. Lo ejecuta GitHub Actions
 * cada hora (ver .github/workflows/pages.yml) y publica en la web, por modelo:
 *
 *  - viento/<modelo>/index.json: la pasada, la rejilla y la lista de horas.
 *  - viento/<modelo>/<pasada>/fNNN.gz: el viento a 10 m (u, v) y la racha de
 *    cada hora de previsión (formato en src/shared/windgrid.js).
 *
 * Modelos (los tres permiten reutilizar los datos):
 *  - ecmwf: ECMWF IFS 0,25° (CC BY 4.0), de data.ecmwf.int: el índice de cada
 *    fichero dice dónde está cada variable y se piden solo esos trozos. Cada 3 h
 *    hasta +96 h.
 *  - icon-eu: ICON-EU del DWD (CC BY 4.0), 0,0625°, de opendata.dwd.de: un
 *    fichero .bz2 por variable y hora (se descomprime con bzip2). Cada hora hasta
 *    +48 h y cada 3 h hasta +78 h; solo la península y alrededores.
 *  - gfs: GFS 0,25° de NOAA (dominio público), con el filtro de NOMADS, que
 *    recorta Europa y deja solo las tres variables. Cada hora hasta +54 h.
 * Los tres salen cuatro veces al día (00, 06, 12 y 18 UTC, unas horas después):
 * si la pasada más reciente ya es la publicada, se copian los ficheros de la
 * web en lugar de volver a pedirlos.
 *
 * Uso: node scripts/viento/datos.mjs <carpeta de salida> [<URL o carpeta con lo publicado>] [<modelo>…]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseGrib2, extract } from './grib2.mjs';

const require = createRequire(import.meta.url);
const W = require('../../src/shared/windgrid.js');

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
async function bytesOf(url, opts) {
  const res = await fetchOk(url, opts);
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} (${new URL(url).host})`);
  return new Uint8Array(await res.arrayBuffer());
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

/** u, v y racha de una hora, ya recortados a la rejilla del modelo. */
function pickFields(msgs, grid, run, h, { u, v, gust }) {
  const find = ([num, surface], name) => {
    const m = msgs.find((x) => x.cat === 2 && x.num === num && x.surface === surface);
    if (!m) throw new Error(`falta ${name} a +${h} h`);
    if (Math.abs(m.hour - h) > 1e-6 || runId(m.refTime) !== run) throw new Error(`se pidió ${run} +${h} h y llegó ${runId(m.refTime)} +${m.hour} h`);
    return extract(m, grid);
  };
  return W.encode({ u: find(u, 'u'), v: find(v, 'v'), gust: gust ? find(gust, 'la racha') : new Float32Array(grid.rows * grid.cols) }, grid);
}
// Código de cada variable en GRIB2: [parámetro de la categoría 2 (viento), tipo de nivel].
const U10 = [2, 103], V10 = [3, 103], GUST10 = [22, 103], GUST_SFC = [22, 1];

// ---------------------------------------------------------------------------
// Modelos

const nomads = limiter(1000);
const ecmwf = limiter(150);
const dwd = limiter(100);

const SOURCES = {
  gfs: {
    hours: range(0, 54),
    concurrency: 3,
    async step(run, h, grid) {
      const day = run.slice(0, 8), hh = run.slice(8, 10);
      const d = W.DOMAIN;
      const q = new URLSearchParams({
        dir: `/gfs.${day}/${hh}/atmos`, file: `gfs.t${hh}z.pgrb2.0p25.f${pad(h, 3)}`,
        var_UGRD: 'on', var_VGRD: 'on', var_GUST: 'on', lev_10_m_above_ground: 'on', lev_surface: 'on',
        subregion: '', toplat: String(d.north), leftlon: String(d.west), rightlon: String(d.east), bottomlat: String(d.south)
      });
      await nomads();
      const buf = await bytesOf(`https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?${q}`);
      return buf && pickFields(parseGrib2(buf), grid, run, h, { u: U10, v: V10, gust: GUST_SFC });
    }
  },
  ecmwf: {
    hours: range(0, 96, 3),
    concurrency: 3,
    async step(run, h, grid) {
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
        if (e.levtype === 'sfc' && ['10u', '10v', '10fg', '10fg3', '10fg6'].includes(e.param)) fields.set(e.param, e);
      }
      const parts = [];
      // La racha es la máxima de la última hora (10fg; desde +93 h, de las últimas 3: 10fg3). A +0 h no hay.
      const gust = ['10fg', '10fg3', '10fg6'].find((p) => fields.has(p));
      for (const p of h > 0 ? ['10u', '10v', gust || '10fg'] : ['10u', '10v']) {
        const e = fields.get(p);
        if (!e) throw new Error(`ECMWF +${h} h: falta ${p}`);
        await ecmwf();
        const b = await bytesOf(`${base}.grib2`, { headers: { Range: `bytes=${e._offset}-${e._offset + e._length - 1}` } });
        if (!b || b.length !== e._length) throw new Error(`ECMWF +${h} h: ${p} incompleto`);
        parts.push(...parseGrib2(b));
      }
      return pickFields(parts, grid, run, h, { u: U10, v: V10, gust: h > 0 ? GUST10 : null });
    }
  },
  'icon-eu': {
    hours: [...range(0, 48), ...range(51, 78, 3)],
    concurrency: 4,
    async step(run, h, grid) {
      const hh = run.slice(8, 10);
      const msgs = [];
      for (const v of ['U_10M', 'V_10M', 'VMAX_10M']) {
        await dwd();
        const bz = await bytesOf(`https://opendata.dwd.de/weather/nwp/icon-eu/grib/${hh}/${v.toLowerCase()}/icon-eu_europe_regular-lat-lon_single-level_${run}_${pad(h, 3)}_${v}.grib2.bz2`);
        if (!bz) return null;
        const out = spawnSync('bzip2', ['-dc'], { input: bz, maxBuffer: 64 * 1024 * 1024 });
        if (out.status !== 0) throw new Error(`bzip2: ${out.error ? out.error.message : String(out.stderr).trim()}`);
        msgs.push(...parseGrib2(out.stdout));
      }
      return pickFields(msgs, grid, run, h, { u: U10, v: V10, gust: GUST10 });
    }
  }
};

async function fromSource(id, run) {
  const src = SOURCES[id], grid = gridOf(id);
  // Primero la última hora: si no está, la pasada aún se está publicando.
  const lastH = src.hours[src.hours.length - 1];
  const last = await src.step(run, lastH, grid);
  if (!last) return null;
  const steps = new Map([[lastH, last]]);
  const todo = src.hours.slice(0, -1);
  const worker = async () => {
    while (todo.length) {
      const h = todo.shift();
      try {
        const s = await src.step(run, h, grid);
        if (s) steps.set(h, s);
      } catch (e) { log(`${id} +${h} h:`, e.message); }
    }
  };
  await Promise.all(Array.from({ length: src.concurrency }, worker));
  // Solo horas seguidas desde el principio (un hueco en medio rompería la animación).
  const out = [];
  for (const h of src.hours) { if (!steps.has(h)) break; out.push([h, steps.get(h)]); }
  if (out.length < Math.ceil(src.hours.length / 2)) throw new Error(`${run}: solo ${out.length} horas seguidas`);
  return out;
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
  for (const s of index.steps) {
    const gz = await readPrev(`${id}/${s.f}`);
    if (!gz) throw new Error(`falta ${id}/${s.f} en lo publicado`);
    const raw = gunzipSync(gz);
    W.decode(raw, index.grid); // comprueba el tamaño
    out.push([s.h, raw]);
  }
  return out;
}

// ---------------------------------------------------------------------------

async function model(id) {
  const grid = gridOf(id);
  let prev = null;
  try { prev = JSON.parse(await readPrev(`${id}/index.json`)); } catch (e) { prev = null; }
  if (prev && (prev.v !== 1 || prev.model !== id || JSON.stringify(prev.grid) !== JSON.stringify(grid))) prev = null; // otro formato o rejilla
  log(`${id}: publicado ${prev ? prev.run : 'nada'}`);

  // Pasadas candidatas, de la más reciente a la de hace un día.
  const latest = Math.floor(Date.now() / CYCLE) * CYCLE;
  let run = null, steps = null;
  for (const r of [0, 1, 2, 3, 4].map((k) => runId(latest - k * CYCLE))) {
    if (prev && r === prev.run) {
      try { steps = await fromPrev(id, prev); run = r; log(`${id} ${r}: copiada de lo publicado`); break; } catch (e) { log(`${id} ${r}:`, e.message); }
    }
    if (prev && runTime(r) < runTime(prev.run)) {
      // Más antigua que la publicada: mejor seguir con aquella si la fuente falla.
      try { steps = await fromPrev(id, prev); run = prev.run; log(`${id} ${prev.run}: se mantiene la publicada`); break; } catch (e) { log(`${id} ${prev.run}:`, e.message); prev = null; }
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

  const dir = path.join(OUT, id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, run), { recursive: true });
  const t0 = runTime(run);
  const list = [];
  let bytes = 0;
  for (const [h, raw] of steps) {
    const gz = gzipSync(raw, { level: 9 });
    bytes += gz.length;
    await fs.writeFile(path.join(dir, stepFile(run, h)), gz);
    list.push({ h, t: t0 + h * 3600000, f: stepFile(run, h) });
  }
  const index = { v: 1, model: id, run, runTime: t0, generated: Date.now(), grid, scale: W.SCALE, steps: list };
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
  log(`${id}: ${run}, ${list.length} horas, ${(bytes / 1e6).toFixed(1)} MB`);
}

// Cada modelo por su cuenta: si uno falla, los demás se publican igual.
const ids = ONLY.length ? ONLY : W.MODELS.map((m) => m.id);
const results = await Promise.allSettled(ids.map(model));
let failed = 0;
results.forEach((r, i) => { if (r.status === 'rejected') { failed++; console.error(`${ids[i]}:`, r.reason && r.reason.message); } });
process.exit(failed ? 1 : 0);
