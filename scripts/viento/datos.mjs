// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Viento para el modo «Viento» de la app y la web. Lo ejecuta GitHub Actions
 * cada hora (ver .github/workflows/pages.yml) y publica en la web:
 *
 *  - viento/index.json: la pasada del modelo, la rejilla y la lista de horas.
 *  - viento/<pasada>/fNNN.gz: el viento a 10 m (u, v) y la racha de cada hora
 *    de previsión (formato en src/shared/windgrid.js).
 *
 * Fuente: GFS 0,25° de NOAA/NCEP (dominio público), con el filtro de NOMADS,
 * que recorta Europa y deja solo esas tres variables (unos 200 kB por hora).
 * GFS sale cuatro veces al día (00, 06, 12 y 18 UTC, unas 4 h después): si la
 * pasada más reciente ya es la publicada, se copian los ficheros de la web en
 * lugar de volver a pedirlos a NOAA.
 *
 * Uso: node scripts/viento/datos.mjs <carpeta de salida> [<URL o carpeta con lo publicado>]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseGrib2, toNorthUp } from './grib2.mjs';

const require = createRequire(import.meta.url);
const W = require('../../src/shared/windgrid.js');

const [OUT, PREV] = process.argv.slice(2);
if (!OUT) { console.error('Uso: node scripts/viento/datos.mjs <salida> [<publicado>]'); process.exit(2); }

const HOURS = Array.from({ length: 55 }, (_, h) => h); // 0–54 h: siempre quedan unas 45 h por delante
const MIN_HOURS = 24;                                   // con menos, mejor lo publicado antes
const CYCLE = 6 * 3600000;
const GRID = W.gridOf();
const NOMADS = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl';
const UA = 'Chubasco (+https://github.com/lalesena/chubasco)';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pad = (n, w = 2) => String(n).padStart(w, '0');
const runId = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`; };
const runTime = (id) => Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10));
const stepFile = (run, h) => `${run}/f${pad(h, 3)}.gz`;

async function fetchOk(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(90000) });
      if (res.ok || res.status === 404 || i >= tries) return res;
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((r) => setTimeout(r, 3000 * i));
  }
}

// ---------------------------------------------------------------------------
// NOMADS

function nomadsUrl(run, h) {
  const day = run.slice(0, 8), hh = run.slice(8, 10);
  const q = new URLSearchParams({
    dir: `/gfs.${day}/${hh}/atmos`, file: `gfs.t${hh}z.pgrb2.0p25.f${pad(h, 3)}`,
    var_UGRD: 'on', var_VGRD: 'on', var_GUST: 'on', lev_10_m_above_ground: 'on', lev_surface: 'on',
    subregion: '', toplat: String(W.DOMAIN.north), leftlon: String(W.DOMAIN.west),
    rightlon: String(W.DOMAIN.east), bottomlat: String(W.DOMAIN.south)
  });
  return `${NOMADS}?${q}`;
}

// Como mucho una petición por segundo: NOAA bloquea durante un rato a quien abusa.
let nextSlot = 0;
async function slot() {
  const wait = nextSlot - Date.now();
  nextSlot = Math.max(nextSlot, Date.now()) + 1000;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Una hora de GFS ya en el formato publicado (bytes sin comprimir), o null si aún no está. */
async function nomadsStep(run, h) {
  await slot();
  const res = await fetchOk(nomadsUrl(run, h));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`NOMADS HTTP ${res.status} (f${pad(h, 3)})`);
  const msgs = parseGrib2(new Uint8Array(await res.arrayBuffer()));
  const pick = (num, surface) => {
    const m = msgs.find((x) => x.cat === 2 && x.num === num && x.surface === surface);
    if (!m) throw new Error(`GFS f${pad(h, 3)}: falta la variable 2.${num}`);
    if (m.hour !== h || runId(m.refTime) !== run) throw new Error(`GFS: se pidió ${run} f${h} y llegó ${runId(m.refTime)} f${m.hour}`);
    return toNorthUp(m, GRID);
  };
  // 2.2 y 2.3: componentes u y v a 10 m (superficie 103); 2.22: racha en superficie (1).
  return W.encode({ u: pick(2, 103), v: pick(3, 103), gust: pick(22, 1) }, GRID);
}

async function fromNomads(run) {
  // Primero la última hora: si no está, la pasada aún se está publicando.
  const last = await nomadsStep(run, HOURS[HOURS.length - 1]);
  if (!last) return null;
  const steps = new Map([[HOURS[HOURS.length - 1], last]]);
  const todo = HOURS.slice(0, -1);
  const worker = async () => {
    while (todo.length) {
      const h = todo.shift();
      try {
        const s = await nomadsStep(run, h);
        if (s) steps.set(h, s);
      } catch (e) { log(`f${pad(h, 3)}:`, e.message); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // Solo horas seguidas desde el principio (un hueco en medio rompería la animación).
  const out = [];
  for (const h of HOURS) { if (!steps.has(h)) break; out.push([h, steps.get(h)]); }
  if (out.length < MIN_HOURS) throw new Error(`GFS ${run}: solo ${out.length} horas seguidas`);
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

async function fromPrev(index) {
  const out = [];
  for (const s of index.steps) {
    const gz = await readPrev(s.f);
    if (!gz) throw new Error(`falta ${s.f} en lo publicado`);
    const raw = gunzipSync(gz);
    W.decode(raw, GRID); // comprueba el tamaño
    out.push([s.h, raw]);
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const prevRaw = await readPrev('index.json');
  let prev = null;
  try { prev = prevRaw && JSON.parse(prevRaw); } catch (e) { prev = null; }
  if (prev && (prev.v !== 1 || JSON.stringify(prev.grid) !== JSON.stringify(GRID))) prev = null; // otro formato o rejilla
  log('publicado:', prev ? prev.run : 'nada');

  // Pasadas candidatas, de la más reciente a la de hace un día.
  const latest = Math.floor(Date.now() / CYCLE) * CYCLE;
  const runs = [0, 1, 2, 3, 4].map((k) => runId(latest - k * CYCLE));
  let run = null, steps = null;
  for (const r of runs) {
    if (prev && r === prev.run) {
      try { steps = await fromPrev(prev); run = r; log(`${r}: copiada de lo publicado`); break; } catch (e) { log(`${r}:`, e.message); }
    }
    if (prev && runTime(r) < runTime(prev.run)) {
      // Más antigua que la publicada: mejor seguir con aquella si NOAA falla.
      try { steps = await fromPrev(prev); run = prev.run; log(`${prev.run}: se mantiene la publicada`); break; } catch (e) { log(prev.run + ':', e.message); prev = null; }
    }
    try {
      steps = await fromNomads(r);
      if (steps) { run = r; log(`${r}: ${steps.length} horas de NOMADS`); break; }
      log(`${r}: aún no está completa en NOMADS`);
    } catch (e) {
      log(`${r}:`, e.message);
    }
  }
  if (!run) throw new Error('No hay ninguna pasada de GFS disponible');

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, run), { recursive: true });
  const t0 = runTime(run);
  const list = [];
  let bytes = 0;
  for (const [h, raw] of steps) {
    const gz = gzipSync(raw, { level: 9 });
    bytes += gz.length;
    await fs.writeFile(path.join(OUT, stepFile(run, h)), gz);
    list.push({ h, t: t0 + h * 3600000, f: stepFile(run, h) });
  }
  const index = {
    v: 1, model: 'GFS', run, runTime: t0, generated: Date.now(),
    grid: GRID, scale: W.SCALE, steps: list
  };
  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  log(`viento: ${run}, ${list.length} horas, ${(bytes / 1e6).toFixed(1)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
