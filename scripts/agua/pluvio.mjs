// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Pluviómetros de AEMET (sin red), para scripts/agua/datos.mjs y las pruebas.
 *
 * El archivo (agua/pluvio/archivo.json.gz, publicado en la web y recuperado
 * en cada ejecución) guarda, por estación:
 *  - hourly: las últimas HOURS horas de la observación horaria, con todas sus
 *    variables (la API solo da las últimas 12 horas: se van acumulando);
 *  - daily: los valores climatológicos diarios de los últimos DAYS días (la
 *    lluvia de cada día va de 07 a 07 UTC; AEMET los publica con unos días de
 *    retraso). Se descargan por tramos de 15 días, hacia atrás, poco a poco.
 * Cada serie es un array alineado con el inicio (hourly.t0, daily.d0).
 */

export const HOURS = 240; // 10 días
export const DAYS = 731; // 2 años
export const CHUNK = 15; // días por consulta (máximo de la API)
const HOUR = 3600000, DAY = 86400000;

// Variables que se guardan (las que publica AEMET; cada estación tiene las suyas).
export const HOURLY_VARS = ['prec', 'ta', 'tamin', 'tamax', 'hr', 'tpr', 'vv', 'vmax', 'dv', 'dmax', 'pres', 'pres_nmar', 'inso', 'vis', 'ts', 'tss5cm', 'tss20cm', 'nieve'];
export const DAILY_VARS = ['prec', 'tmed', 'tmin', 'tmax', 'velmedia', 'racha', 'dir', 'sol', 'presMax', 'presMin', 'hrMedia', 'hrMax', 'hrMin', 'pintMax'];

const isoTime = (s) => Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const dayMs = (k) => Date.parse(k + 'T00:00:00Z');

// 'FIGUERES  ELS ASPRES' → 'Figueres, Els Aspres'; 'D?HOSTOLES' (apóstrofo perdido) → "d'Hostoles".
const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'i', 'e', 'en', 'a', 'al', 'da', 'do', 'das', 'dos']);
export function gaugeName(s) {
  return String(s).trim().replace(/(\p{L})\?(\p{L})/gu, "$1'$2").split(/\s{2,}/).map((part) => part.toLowerCase().split(/(\s+|-|\/|\()/).map((w, i) => {
    if (!/\p{L}/u.test(w)) return w;
    const ap = /^([dl])'(.+)$/.exec(w);
    if (ap) return `${i === 0 ? ap[1].toUpperCase() : ap[1]}'${ap[2][0].toUpperCase()}${ap[2].slice(1)}`;
    if (i > 0 && SMALL.has(w)) return w;
    return w[0].toUpperCase() + w.slice(1);
  }).join('')).join(', ');
}

// '26,5' → 26.5; 'Ip' (menos de 0,1 mm) → 0; 'Acum' (lluvia de varios días) y vacíos → null.
export function dailyNumber(key, s) {
  if (s === undefined || s === null || s === '') return null;
  if (s === 'Ip') return 0;
  const v = Number(String(s).replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  if (key === 'dir') return v >= 0 && v <= 36 ? v * 10 : null; // decenas de grado; 99 = variable, 88 = sin dato
  if (key === 'pintMax' && v < 0) return 0; // -0,3 = inapreciable
  return v;
}

/** Un array alineado desde `start` (n huecos) a partir de otro que empezaba `shift` huecos antes. */
function realign(arr, shift, n) {
  const out = new Array(n).fill(null);
  for (let j = 0; j < n; j++) { const v = arr[j + shift]; if (v !== undefined) out[j] = v; }
  return out;
}

const hasData = (series) => Object.values(series).some((a) => a.some((v) => v !== null));

export function emptyArchive() {
  return { version: 1, meta: {}, hourly: null, daily: null, fetched: {} };
}

/** Añade la observación horaria (filas de /observacion/convencional/todas). */
export function ingestHourly(arch, rows, now) {
  const end = Math.floor(now / HOUR) * HOUR;
  const t0 = end - (HOURS - 1) * HOUR;
  const prev = arch.hourly;
  const data = {};
  if (prev) {
    const shift = (t0 - prev.t0) / HOUR;
    for (const [id, series] of Object.entries(prev.data)) {
      const s = {};
      for (const [k, a] of Object.entries(series)) s[k] = realign(a, shift, HOURS);
      if (hasData(s)) data[id] = s;
    }
  }
  for (const r of rows) {
    if (!r || !/^[0-9A-Z]{1,8}$/.test(r.idema || '') || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const m = arch.meta[r.idema] || (arch.meta[r.idema] = {});
    m.name = gaugeName(r.ubi || r.idema);
    m.lat = Math.round(r.lat * 1e4) / 1e4; m.lon = Math.round(r.lon * 1e4) / 1e4;
    if (Number.isFinite(r.alt)) m.alt = r.alt;
    const t = isoTime(r.fint);
    const i = (t - t0) / HOUR;
    if (!Number.isInteger(i) || i < 0 || i >= HOURS) continue;
    const s = data[r.idema] || (data[r.idema] = {});
    for (const k of HOURLY_VARS) {
      const v = r[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (k === 'prec' && (v < 0 || v > 250)) continue;
      (s[k] || (s[k] = new Array(HOURS).fill(null)))[i] = Math.round(v * 10) / 10;
    }
  }
  arch.hourly = { t0, data };
  return arch;
}

/** Añade valores diarios (filas de /valores/climatologicos/diarios/.../todasestaciones). */
export function ingestDaily(arch, rows, now) {
  const horizon = dayMs(dayKey(now)) - DAYS * DAY;
  const dates = rows.map((r) => r && dayMs(r.fecha)).filter((t) => Number.isFinite(t) && t >= horizon);
  if (!dates.length) return arch;
  const prev = arch.daily;
  const prevStart = prev ? dayMs(prev.d0) : Infinity;
  const prevEnd = prev ? prevStart + (prev.n - 1) * DAY : -Infinity;
  const start = Math.max(horizon, Math.min(prevStart, ...dates));
  const end = Math.max(prevEnd, ...dates);
  const n = Math.round((end - start) / DAY) + 1;
  const data = {};
  if (prev) {
    const shift = Math.round((start - prevStart) / DAY);
    for (const [id, series] of Object.entries(prev.data)) {
      const s = {};
      for (const [k, a] of Object.entries(series)) s[k] = realign(a, shift, n);
      if (hasData(s)) data[id] = s;
    }
  }
  for (const r of rows) {
    if (!r || !/^[0-9A-Z]{1,8}$/.test(r.indicativo || '')) continue;
    const t = dayMs(r.fecha);
    if (!(t >= start && t <= end)) continue;
    const i = Math.round((t - start) / DAY);
    const m = arch.meta[r.indicativo] || (arch.meta[r.indicativo] = {});
    if (r.provincia) m.prov = gaugeName(r.provincia);
    if (!m.name && r.nombre) m.name = gaugeName(r.nombre);
    if (m.alt === undefined && r.altitud) m.alt = Number(r.altitud);
    const s = data[r.indicativo] || (data[r.indicativo] = {});
    for (const k of DAILY_VARS) {
      const v = dailyNumber(k, r[k]);
      if (v === null) continue;
      (s[k] || (s[k] = new Array(n).fill(null)))[i] = v;
    }
  }
  arch.daily = { d0: dayKey(start), n, data };
  return arch;
}

/**
 * Qué tramos diarios pedir en esta ejecución: los últimos 15 días si hace más
 * de `refreshMs` que no se piden, y hasta `maxBack` tramos hacia atrás hasta
 * completar DAYS. Devuelve [{from, to, kind}] con fechas 'YYYY-MM-DD'.
 */
export function planDaily(arch, now, { maxBack = 6, refreshMs = 3 * HOUR } = {}) {
  const today = dayMs(dayKey(now));
  const horizon = today - DAYS * DAY;
  const f = arch.fetched || {};
  const out = [];
  if (!f.latestAt || now - f.latestAt > refreshMs) out.push({ from: dayKey(today - (CHUNK - 1) * DAY), to: dayKey(today), kind: 'latest' });
  let oldest = f.oldest ? dayMs(f.oldest) : today - (CHUNK - 1) * DAY;
  for (let k = 0; k < maxBack && oldest > horizon; k++) {
    const from = Math.max(horizon, oldest - CHUNK * DAY);
    out.push({ from: dayKey(from), to: dayKey(oldest - DAY), kind: 'back' });
    oldest = from;
  }
  return out;
}

/** Anota un tramo ya pedido (aunque viniera vacío, para no repetirlo). */
export function markFetched(arch, chunk, now) {
  const f = arch.fetched || (arch.fetched = {});
  if (chunk.kind === 'latest') { f.latestAt = now; if (!f.oldest || chunk.from < f.oldest) f.oldest = chunk.from; }
  if (chunk.kind === 'back' && (!f.oldest || chunk.from < f.oldest)) f.oldest = chunk.from;
  return arch;
}

// ---------------------------------------------------------------------------
// Lo que se publica

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Lluvia desde `from` (ms) hasta la última hora: los días climatológicos que
 * haya (07 a 07 UTC) y, después del último, las horas. null si falta más del
 * 10 % de los días o de las horas. Con `daysOnly`, solo los días.
 */
function rainSince(arch, id, from, daysOnly) {
  const h = arch.hourly, d = arch.daily;
  const hs = h && h.data[id] && h.data[id].prec;
  const ds = d && d.data[id] && d.data[id].prec;
  const hEnd = h ? h.t0 + (HOURS - 1) * HOUR : null;
  let mm = 0, need = 0, got = 0, cursor = from, first = null;
  if (d) {
    // Día climatológico D: de D 07:00 a D+1 07:00 UTC.
    const d0 = dayMs(d.d0);
    for (let i = 0; i < d.n; i++) {
      const s = d0 + i * DAY + 7 * HOUR;
      if (s < from) continue;
      if (hEnd !== null && s + DAY > hEnd) break;
      need++;
      if (first === null) first = s;
      const v = ds ? ds[i] : null;
      if (v !== null && v !== undefined) { mm += v; got++; }
      cursor = s + DAY;
    }
  }
  if (need && got < need * 0.9) return null;
  if (first !== null && first > from) return null; // los días guardados empiezan después
  if (!h || daysOnly) return need ? r1(mm) : null;
  // Horas que terminan después de `cursor`.
  let hn = 0, hg = 0;
  for (let i = 0; i < HOURS; i++) {
    const t = h.t0 + i * HOUR;
    if (t <= cursor) continue;
    hn++;
    const v = hs ? hs[i] : null;
    if (v !== null && v !== undefined) { mm += v; hg++; }
  }
  if (cursor < h.t0 - HOUR) return null; // hay un hueco entre los días y las horas guardadas
  if (hn && hg < hn * 0.9) return null;
  return r1(mm);
}

// Valor de la última hora con datos (o la anterior: algunas estaciones llegan tarde).
function lastHourly(arch, id, k, iLast) {
  const s = arch.hourly && arch.hourly.data[id] && arch.hourly.data[id][k];
  if (!s) return null;
  for (let i = iLast; i >= iLast - 1; i--) if (s[i] !== null && s[i] !== undefined) return s[i];
  return null;
}

function hydroStart(now) {
  const d = new Date(now);
  const y = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return Date.UTC(y, 9, 1, 7);
}

/**
 * Hasta dónde llegan los periodos de varios días. Lo normal es hasta la
 * última hora (días climatológicos y luego horas). Si entre el último día
 * publicado y las horas guardadas hay un hueco (al empezar, o si la tarea se
 * paró), los periodos terminan en el último día publicado: {end, daysOnly}.
 */
function periodEnd(arch, end) {
  const d = arch.daily, h = arch.hourly;
  if (!d) return { end, daysOnly: false };
  const dEnd = dayMs(d.d0) + d.n * DAY + 7 * HOUR; // fin del último día climatológico
  // Primera hora guardada con lluvia en alguna estación (el resto de la ventana puede estar vacío).
  let first = HOURS;
  if (h) for (const sr of Object.values(h.data)) if (sr.prec) for (let i = 0; i < first; i++) if (sr.prec[i] !== null) { first = i; break; }
  if (h && first < HOURS && h.t0 + (first - 1) * HOUR <= dEnd) return { end, daysOnly: false };
  return { end: dEnd, daysOnly: true };
}

/**
 * Resumen por estación: [id, nombre, lat, lon, 1 h, 24 h, 7 días, 30 días,
 * desde el 1 de octubre, temperatura], y hasta cuándo llegan los periodos.
 */
export function summarize(arch, now) {
  if (!arch.hourly) return null;
  // La última hora con lluvia medida en alguna estación (la en curso aún no ha llegado).
  let iLast = -1;
  for (const s of Object.values(arch.hourly.data)) if (s.prec) for (let i = HOURS - 1; i > iLast; i--) if (s.prec[i] !== null) { iLast = i; break; }
  if (iLast < 0) return null;
  const end = arch.hourly.t0 + iLast * HOUR;
  const P = periodEnd(arch, end);
  const today7 = dayMs(dayKey(P.end - 7 * HOUR)) + 7 * HOUR; // 07:00 UTC del último día del periodo
  const stations = [];
  for (const [id, m] of Object.entries(arch.meta)) {
    if (!Number.isFinite(m.lat)) continue;
    const hs = arch.hourly.data[id] && arch.hourly.data[id].prec;
    let h24 = null;
    if (hs) {
      let s = 0, n = 0;
      for (let i = iLast - 23; i <= iLast; i++) if (i >= 0 && hs[i] !== null) { s += hs[i]; n++; }
      if (n >= 22) h24 = r1(s);
    }
    const h1 = lastHourly(arch, id, 'prec', iLast);
    const since = (from) => rainSince(arch, id, from, P.daysOnly);
    const row = [id, m.name, m.lat, m.lon, h1, h24, since((P.daysOnly ? P.end : today7) - 7 * DAY), since((P.daysOnly ? P.end : today7) - 30 * DAY), since(hydroStart(Math.min(now, P.end))), lastHourly(arch, id, 'ta', iLast)];
    if (row.slice(4, 9).some((v) => v !== null)) stations.push(row);
  }
  return { until: new Date(end).toISOString(), periodsUntil: new Date(P.end).toISOString(), stations };
}

/** Ficha de una estación: datos fijos, resumen y series (solo las variables que tiene). */
export function stationFile(arch, id, row) {
  const m = arch.meta[id] || {};
  const pick = (block) => {
    const s = block && block.data[id];
    if (!s) return {};
    return Object.fromEntries(Object.entries(s).filter(([, a]) => a.some((v) => v !== null)));
  };
  return {
    id, name: m.name, prov: m.prov, alt: m.alt, lat: m.lat, lon: m.lon,
    now: row ? { h1: row[4], h24: row[5], d7: row[6], d30: row[7], year: row[8] } : null,
    hourly: arch.hourly ? { t0: new Date(arch.hourly.t0).toISOString(), vars: pick(arch.hourly) } : null,
    daily: arch.daily ? { d0: arch.daily.d0, vars: pick(arch.daily) } : null
  };
}
