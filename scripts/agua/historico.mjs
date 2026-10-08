// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Historia larga de los pluviómetros de AEMET (sin red), para scripts/agua/datos.mjs
 * y las pruebas: serie mensual desde 1920, normales 1991-2020 y récords oficiales.
 *
 * Se guarda en agua/pluvio/historico.json.gz (aparte de archivo.json.gz, que se
 * mantiene pequeño). Solo las estaciones que publicamos (las que tienen posición
 * en el archivo de pluviómetros).
 *
 * ── Qué hay en historico.json.gz ───────────────────────────────────────────
 *  { version: 1,
 *    cursor, edge,        // 'YYYY-MM-DD'. El almacén mensual cubre los días [cursor, edge)
 *    empty,               // días seguidos sin datos antes de 1920 (al llegar a 365, fin)
 *    done,                // true: el relleno hacia atrás ha terminado
 *    miss,                // {from, n}: veces que un tramo vino vacío por completo
 *    stations: { id: { m0:'YYYY-MM', pN:[…], pS:[…], … } },   // acumuladores mensuales
 *    normals:  { id: { v: <normals>|null, next:'YYYY-MM-DD' } },
 *    records:  { id: { v: <records>|null, next:'YYYY-MM-DD' } } }
 *
 * Acumuladores mensuales (un array por cada uno, alineados desde m0; todo en
 * décimas, así los tramos de 15 días se combinan sin error de redondeo):
 *   pN días con lluvia medida · pS suma (mm) · pR días ≥ 0,1 mm · pR1 días ≥ 1 mm
 *   pX máximo diario · pXd día del mes del máximo (0 = sin dato)
 *   tN,tS temperatura media (días, suma) · xN,xS media de máximas · nN,nS media de mínimas
 *   xA,xAd máxima absoluta y su día · nA,nAd mínima absoluta y su día
 *   hN,hS humedad relativa media · wN,wS viento medio (m/s) · sN,sS insolación (h)
 *   gA,gAd racha máxima (m/s) y su día
 * Cada día se suma una sola vez. Los extremos empatados se quedan con el día más
 * temprano, así el resultado no depende del orden en que lleguen los tramos.
 * Los días «Acum» (lluvia de varios días) no tienen valor: el total llega el día en
 * que acaba la racha, así que el total del mes es correcto, el máximo diario puede
 * incluir una acumulación de varios días y la cobertura baja en los días «Acum».
 *
 * ── Cobertura (sin huecos ni días contados dos veces) ─────────────────────
 * El archivo diario (pluvio.mjs) guarda [d0, hoy] (2 años). El almacén guarda
 * [cursor, edge) con `edge` siempre un día 1 y ≥ d0 + ~31 días:
 *  - avance: antes de que la ventana diaria suelte días viejos, los días
 *    [edge, nuevoEdge) pasan del archivo diario al almacén (rollForward);
 *  - relleno: se piden tramos de 15 días de todas las estaciones hacia atrás
 *    desde `cursor` (nunca más allá de `edge`) y se suman (nextChunk, ingestChunk).
 * Al publicar, los meses anteriores a `edge` salen del almacén y los demás se
 * calculan al vuelo con el archivo diario, con el mismo código (combined).
 *
 * ── Ficha de estación (pluvio/<id>.json) ───────────────────────────────────
 * Se añaden tres campos (stationExtras); los que ya había no cambian. Si no hay
 * datos de uno, no aparece. `null` = sin dato. Unidades: mm, °C, %, m/s, h.
 *
 *  history: {                 // serie mensual desde el primer mes con datos
 *    m0: '1920-01',           // mes del primer elemento de todos los arrays
 *    complete: false,         // false mientras el relleno hacia atrás siga en marcha
 *    prec:      [mm],         // lluvia total del mes
 *    rainDays:  [días],       // días con ≥ 0,1 mm
 *    rainDays1: [días],       // días con ≥ 1 mm
 *    precMax:   [mm],         // mayor lluvia diaria del mes
 *    tmean:     [°C],         // media de las temperaturas medias diarias
 *    tmax:      [°C],         // media de las máximas diarias
 *    tmin:      [°C],         // media de las mínimas diarias
 *    tmaxAbs:   [°C],         // mayor máxima diaria del mes
 *    tminAbs:   [°C],         // menor mínima diaria del mes
 *    hr:        [%],          // humedad relativa media (entero)
 *    wind:      [m/s],        // viento medio
 *    gust:      [m/s],        // racha máxima del mes
 *    sun:       [h/día],      // insolación media diaria
 *    cov:       [0-100] }     // % de días del mes con lluvia medida
 *    // Las medias (tmean, tmax, tmin, hr, wind, sun) solo salen si hay datos de la
 *    // mitad de los días del mes. Los totales, recuentos y extremos salen con un
 *    // solo día: son cotas inferiores, y `cov` dice cuánto del mes se midió (el mes
 *    // en curso sale incompleto). Las variables que la estación nunca mide no salen.
 *
 *  normals: {                 // normales climatológicas de AEMET
 *    period: '1991-2020', n: 30,    // n = años usados para la lluvia
 *    months: { prec:[12], … },      // enero…diciembre
 *    year:   { prec: 416.8, … } }   // el año completo
 *    // Claves (mismas que history cuando significan lo mismo; "media" = media de los años):
 *    //  prec media mensual · precMed mediana · precLo/precHi el mes más seco/lluvioso
 *    //  del periodo · precQ [[q1×12],[q2×12],[q3×12],[q4×12]] (en year: [q1,q2,q3,q4]),
 *    //  límites de quintil (20/40/60/80 %) de la lluvia mensual
 *    //  rainDays (≥ 0,1 mm) · rainDays1 (≥ 1 mm) · precMax media de la mayor lluvia diaria
 *    //  · precMaxHi mayor lluvia diaria del periodo
 *    //  tmean · tmax · tmin · tmaxAbs/tminAbs media de la máxima/mínima absoluta del mes
 *    //  · tmaxHi/tminLo la mayor máxima / menor mínima del periodo
 *    //  hr · wind (m/s; AEMET lo da en km/h) · gust media de la racha máxima mensual ·
 *    //  gustHi mayor racha · sun (h/día)
 *    //  snowDays · stormDays · fogDays · clearDays · frostDays (mín ≤ 0 °C) · hotDays (máx ≥ 30 °C)
 *
 *  records: {                 // récords de toda la serie de la estación
 *    source: 'aemet' | 'calculado',   // calculado: de nuestro histórico (solo con el relleno acabado)
 *    from: 'YYYY-MM',                 // solo calculado: primer mes con datos
 *    all:   { precDay: [mm, 'YYYY-MM-DD'], precHi: [mm, 'YYYY-MM'], … },
 *    month: { precDay: [[mm, 'YYYY-MM-DD'] | null × 12], … } }   // récord de cada mes (ene…dic)
 *    // Claves: precDay mayor lluvia diaria · precHi/precLo mes más lluvioso/seco ·
 *    //  rainDays más días de lluvia en un mes · tmaxHi/tminLo temperatura más alta/baja ·
 *    //  tmeanHi/tmeanLo mes más cálido/frío (media) · tmaxMeanHi mayor media de máximas ·
 *    //  tminMeanLo menor media de mínimas · gustHi mayor racha (m/s; AEMET la da en km/h)
 *    //  Solo 'aemet': snowDays, stormDays (más días de nieve/tormenta en un mes).
 *    //  Fechas: 'YYYY-MM-DD' en los récords de un día, 'YYYY-MM' en los de un mes.
 *    //  'calculado' solo cuenta meses con ≥ 90 % de los días medidos (salvo los de un día).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DAYS, CHUNK, dailyNumber } from './pluvio.mjs';

export const FLOOR = '1900-01-01'; // hasta donde se intenta llegar
export const DATA_START = '1920-01-01'; // AEMET no tiene diarios anteriores
export const EMPTY_STOP = 365; // días seguidos sin datos (antes de 1920) tras los que se da por acabado
export const SLACK = 31; // días de margen entre el inicio de la ventana diaria y `edge`
export const NORMALS_EVERY = 180, RECORDS_EVERY = 90, RETRY_NONE = 30, RETRY_ERROR = 1; // días
const MISS_MAX = 2; // veces que un tramo vacío por completo se reintenta antes de darlo por vacío
const DAY = 86400000;

const dayMs = (k) => Date.parse(k + 'T00:00:00Z');
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (k, n) => dayKey(dayMs(k) + n * DAY);
const mIdx = (y, m0) => y * 12 + m0;
const mKey = (i) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
const mParse = (s) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
const monthStart = (i) => Date.UTC(Math.floor(i / 12), i % 12, 1);
const daysIn = (i) => new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)).getUTCDate();
const r1 = (v) => Math.round(v * 10) / 10;

/** Primer día de mes igual o posterior a `ms`. */
function ceilMonth(ms) {
  const d = new Date(ms);
  return d.getUTCDate() === 1 ? dayKey(ms) : dayKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Inicio de la ventana diaria (la que guarda pluvio.mjs) para el instante `now`. */
export const windowStart = (now) => dayMs(dayKey(now)) - DAYS * DAY;
/** Dónde tiene que estar `edge` en `now`: un día 1 que deja SLACK días de margen. */
export const edgeFor = (now) => ceilMonth(windowStart(now) + SLACK * DAY);

// ---------------------------------------------------------------------------
// Acumuladores mensuales de una estación

export const ACC = ['pN', 'pS', 'pR', 'pR1', 'pX', 'pXd', 'tN', 'tS', 'xN', 'xS', 'xA', 'xAd', 'nN', 'nS', 'nA', 'nAd', 'hN', 'hS', 'wN', 'wS', 'gA', 'gAd', 'sN', 'sS'];

const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const ten = (v) => Math.round(v * 10);

/** Asegura que los arrays cubren el mes `idx`; devuelve su posición. */
function slot(st, idx) {
  if (st.m0 === undefined) {
    st.m0 = mKey(idx);
    for (const k of ACC) st[k] = [0];
    return 0;
  }
  const base = mParse(st.m0), len = st.pN.length;
  if (idx < base) {
    const pad = new Array(base - idx).fill(0);
    for (const k of ACC) st[k] = pad.concat(st[k]);
    st.m0 = mKey(idx);
    return 0;
  }
  if (idx >= base + len) for (const k of ACC) { const a = st[k]; while (a.length <= idx - base) a.push(0); }
  return idx - base;
}

/**
 * Suma un día (y/m0/d: año, mes desde 0, día del mes) a los acumuladores de `st`.
 * `v`: {prec, tmed, tmax, tmin, hr, vel, racha, sol} en mm, °C, %, m/s, h (null = sin dato).
 * Valores fuera de lo físicamente posible se ignoran.
 */
export function addDay(st, y, m0, d, v) {
  const i = slot(st, mIdx(y, m0));
  if (inRange(v.prec, 0, 1000)) {
    const t = ten(v.prec);
    st.pN[i]++; st.pS[i] += t;
    if (t >= 1) st.pR[i]++;
    if (t >= 10) st.pR1[i]++;
    if (st.pXd[i] === 0 || t > st.pX[i] || (t === st.pX[i] && d < st.pXd[i])) { st.pX[i] = t; st.pXd[i] = d; }
  }
  if (inRange(v.tmed, -60, 60)) { st.tN[i]++; st.tS[i] += ten(v.tmed); }
  if (inRange(v.tmax, -60, 60)) {
    const t = ten(v.tmax);
    st.xN[i]++; st.xS[i] += t;
    if (st.xAd[i] === 0 || t > st.xA[i] || (t === st.xA[i] && d < st.xAd[i])) { st.xA[i] = t; st.xAd[i] = d; }
  }
  if (inRange(v.tmin, -60, 60)) {
    const t = ten(v.tmin);
    st.nN[i]++; st.nS[i] += t;
    if (st.nAd[i] === 0 || t < st.nA[i] || (t === st.nA[i] && d < st.nAd[i])) { st.nA[i] = t; st.nAd[i] = d; }
  }
  if (inRange(v.hr, 0, 100)) { st.hN[i]++; st.hS[i] += ten(v.hr); }
  if (inRange(v.vel, 0, 80)) { st.wN[i]++; st.wS[i] += ten(v.vel); }
  if (inRange(v.racha, 0, 120)) {
    const t = ten(v.racha);
    if (st.gAd[i] === 0 || t > st.gA[i] || (t === st.gA[i] && d < st.gAd[i])) { st.gA[i] = t; st.gAd[i] = d; }
  }
  if (inRange(v.sol, 0, 24)) { st.sN[i]++; st.sS[i] += ten(v.sol); }
}

/** Valores de un día a partir de una fila de la API (cadenas con coma decimal, 'Ip', 'Acum'). */
export function rowValues(r) {
  return {
    prec: dailyNumber('prec', r.prec), tmed: dailyNumber('tmed', r.tmed), tmax: dailyNumber('tmax', r.tmax), tmin: dailyNumber('tmin', r.tmin),
    hr: dailyNumber('hrMedia', r.hrMedia), vel: dailyNumber('velmedia', r.velmedia), racha: dailyNumber('racha', r.racha), sol: dailyNumber('sol', r.sol)
  };
}

const hasMonth = (st, i) => st.pN[i] + st.tN[i] + st.xN[i] + st.nN[i] + st.hN[i] + st.wN[i] + st.sN[i] + st.gAd[i] > 0;

// ---------------------------------------------------------------------------
// El almacén

export function emptyHistory() {
  return { version: 1, cursor: null, edge: null, empty: 0, done: false, miss: null, stations: {}, normals: {}, records: {} };
}

/** Estaciones que publicamos: las que tienen posición en el archivo de pluviómetros. */
export function listedIds(arch) {
  return Object.entries(arch.meta || {}).filter(([id, m]) => m && Number.isFinite(m.lat) && /^[0-9A-Z]{1,8}$/.test(id)).map(([id]) => id);
}

/** Días [from, to) del archivo diario, de las estaciones `ids`, sumados al almacén. Devuelve cuántos días. */
export function ingestArchive(h, arch, from, to, ids = listedIds(arch)) {
  const d = arch.daily;
  if (!d) return 0;
  let n = 0;
  for (const id of ids) {
    const st = h.stations[id] || {};
    n += feedArchive(st, d, id, from, to);
    if (st.m0 !== undefined) h.stations[id] = st;
  }
  return n;
}

function feedArchive(st, d, id, from, to) {
  const s = d.data[id];
  if (!s) return 0;
  const d0 = dayMs(d.d0);
  const a = Math.max(0, Math.round((dayMs(from) - d0) / DAY)), b = Math.min(d.n, Math.round((dayMs(to) - d0) / DAY));
  let n = 0;
  for (let i = a; i < b; i++) {
    const v = {
      prec: s.prec ? s.prec[i] : null, tmed: s.tmed ? s.tmed[i] : null, tmax: s.tmax ? s.tmax[i] : null, tmin: s.tmin ? s.tmin[i] : null,
      hr: s.hrMedia ? s.hrMedia[i] : null, vel: s.velmedia ? s.velmedia[i] : null, racha: s.racha ? s.racha[i] : null, sol: s.sol ? s.sol[i] : null
    };
    if (Object.values(v).every((x) => x === null || x === undefined)) continue;
    const t = new Date(d0 + i * DAY);
    addDay(st, t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), v);
    n++;
  }
  return n;
}

/**
 * Avance del borde: pasa del archivo diario al almacén los días [edge, nuevo edge)
 * (ya tienen ~2 años: son definitivos). Se llama al principio de cada ejecución,
 * antes de que el archivo diario suelte días. La primera vez solo fija edge y cursor.
 * Si el archivo diario aún no tiene descargados esos días, espera.
 */
export function rollForward(h, arch, now) {
  const target = edgeFor(now);
  if (!h.edge) { h.edge = target; h.cursor = target; return { init: true, days: 0 }; }
  if (h.edge >= target) return { days: 0 };
  const f = arch.fetched || {};
  if (!arch.daily || !f.oldest || f.oldest > h.edge) return { waiting: true, days: 0 };
  const days = ingestArchive(h, arch, h.edge, target);
  const d0 = arch.daily.d0;
  const lost = d0 > h.edge ? Math.round((dayMs(d0) - dayMs(h.edge)) / DAY) : 0; // si la tarea estuvo parada más de lo que da el margen
  h.edge = target;
  return { days, lost };
}

const floorOf = (h) => dayMs(h.floor || FLOOR); // h.floor solo se usa en las pruebas

/** El siguiente tramo que pedir hacia atrás, {from, to} ('YYYY-MM-DD'), o null si ya se acabó. */
export function nextChunk(h) {
  if (h.done || !h.cursor || !h.edge) return null;
  const cur = dayMs(h.cursor);
  if (cur <= floorOf(h)) { h.done = true; return null; }
  return { from: dayKey(Math.max(floorOf(h), cur - CHUNK * DAY)), to: dayKey(cur - DAY) };
}

/**
 * Suma un tramo pedido (filas de /diarios/.../todasestaciones, también []) y
 * mueve el cursor. Devuelve {ingested, advanced}: advanced es false si el tramo
 * vino vacío del todo después de 1920 (puede ser un fallo de AEMET; se repetirá
 * en la próxima ejecución antes de darlo por vacío).
 */
export function ingestChunk(h, arch, chunk, rows, ids = listedIds(arch)) {
  const want = new Set(ids), seen = new Set(), from = dayMs(chunk.from), to = dayMs(chunk.to), edge = dayMs(h.edge);
  const empty = rows.length === 0;
  if (empty && chunk.to >= DATA_START) {
    const miss = h.miss && h.miss.from === chunk.from ? h.miss.n : 0;
    if (miss < MISS_MAX) { h.miss = { from: chunk.from, n: miss + 1 }; return { ingested: 0, advanced: false }; }
  }
  let ingested = 0;
  for (const r of rows) {
    if (!r || !want.has(r.indicativo) || typeof r.fecha !== 'string') continue;
    const t = dayMs(r.fecha);
    if (!(t >= from && t <= to) || t >= edge) continue; // nunca fuera del tramo ni más allá de edge
    const key = r.indicativo + r.fecha;
    if (seen.has(key)) continue; // un día, una sola vez
    seen.add(key);
    const v = rowValues(r);
    if (Object.values(v).every((x) => x === null)) continue;
    const st = h.stations[r.indicativo] || (h.stations[r.indicativo] = {});
    const dt = new Date(t);
    addDay(st, dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), v);
    ingested++;
  }
  const days = Math.round((to - from) / DAY) + 1;
  h.empty = ingested === 0 && chunk.to < DATA_START ? h.empty + days : 0;
  h.cursor = chunk.from;
  h.miss = null;
  if (h.empty >= EMPTY_STOP || dayMs(h.cursor) <= floorOf(h)) h.done = true;
  return { ingested, advanced: true };
}

// ---------------------------------------------------------------------------
// Serie mensual de una estación: almacén (meses anteriores a edge) + archivo diario (el resto)

/**
 * Acumuladores de la estación mes a mes, desde el primer al último mes con datos:
 * {m0, <ACC>: arrays} o null. Los meses a partir de `edge` se calculan del archivo
 * diario con addDay; los anteriores, del almacén, salvo los del cursor hacia atrás
 * si el relleno sigue en marcha (el mes del cursor puede estar a medias).
 */
export function combined(h, arch, id) {
  const store = h.stations[id];
  const live = {};
  if (arch.daily && h.edge) feedArchive(live, arch.daily, id, h.edge, addDays(arch.daily.d0, arch.daily.n));
  else if (arch.daily) feedArchive(live, arch.daily, id, arch.daily.d0, addDays(arch.daily.d0, arch.daily.n));
  const edgeIdx = h.edge ? mParse(h.edge.slice(0, 7)) : -Infinity;
  const cursorMs = h.cursor ? dayMs(h.cursor) : -Infinity;
  const srcs = [store, live].filter((s) => s && s.m0 !== undefined).map((s) => ({ s, base: mParse(s.m0), live: s === live }));
  if (!srcs.length) return null;
  const lo = Math.min(...srcs.map((x) => x.base));
  const hi = Math.max(...srcs.map((x) => x.base + x.s.pN.length - 1));
  const out = {};
  for (const k of ACC) out[k] = [];
  let first = -1, last = -1;
  for (let idx = lo; idx <= hi; idx++) {
    let ok = false;
    for (const { s, base, live: isLive } of srcs) {
      const i = idx - base;
      if (i < 0 || i >= s.pN.length || !hasMonth(s, i)) continue;
      // Del archivo diario, los meses desde edge; del almacén, los anteriores (y, mientras el relleno siga, solo los que empiezan en o después del cursor).
      if (isLive ? idx < edgeIdx : idx >= edgeIdx || (!h.done && monthStart(idx) < cursorMs)) continue;
      for (const k of ACC) out[k].push(s[k][i]);
      ok = true;
      break;
    }
    if (!ok) for (const k of ACC) out[k].push(0);
    else { if (first < 0) first = idx - lo; last = idx - lo; }
  }
  if (first < 0) return null;
  for (const k of ACC) out[k] = out[k].slice(first, last + 1);
  out.m0 = mKey(lo + first);
  return out;
}

/** La serie publicada (ver la cabecera): history. */
export function monthlySeries(v, complete) {
  const base = mParse(v.m0), n = v.pN.length;
  const S = { m0: v.m0, complete: !!complete };
  const col = (name, f) => {
    const a = new Array(n);
    let any = false;
    for (let i = 0; i < n; i++) { a[i] = f(i, daysIn(base + i)); if (a[i] !== null) any = true; }
    if (any) S[name] = a;
  };
  const mean = (N, Sum, div, dec) => (i, dim) => (v[N][i] * 2 >= dim ? Math.round((v[Sum][i] / v[N][i]) / div * dec) / dec : null);
  col('prec', (i) => (v.pN[i] ? v.pS[i] / 10 : null));
  col('rainDays', (i) => (v.pN[i] ? v.pR[i] : null));
  col('rainDays1', (i) => (v.pN[i] ? v.pR1[i] : null));
  col('precMax', (i) => (v.pXd[i] ? v.pX[i] / 10 : null));
  col('tmean', mean('tN', 'tS', 10, 10));
  col('tmax', mean('xN', 'xS', 10, 10));
  col('tmin', mean('nN', 'nS', 10, 10));
  col('tmaxAbs', (i) => (v.xAd[i] ? v.xA[i] / 10 : null));
  col('tminAbs', (i) => (v.nAd[i] ? v.nA[i] / 10 : null));
  col('hr', mean('hN', 'hS', 10, 1));
  col('wind', mean('wN', 'wS', 10, 10));
  col('gust', (i) => (v.gAd[i] ? v.gA[i] / 10 : null));
  col('sun', mean('sN', 'sS', 10, 10));
  if (S.prec) S.cov = Array.from({ length: n }, (_, i) => Math.round((100 * v.pN[i]) / daysIn(base + i)));
  return S;
}

// ---------------------------------------------------------------------------
// Normales climatológicas (valores/climatologicos/normales/estacion/<id>)

// clave publicada → [[variable AEMET, estadístico, factor], …] (la primera que tenga dato)
const NORMAL_SPEC = {
  prec: [['p_mes', 'md']], precMed: [['p_mes', 'mn']], precLo: [['p_mes', 'min']], precHi: [['p_mes', 'max']],
  rainDays: [['np_001', 'md'], ['n_llu', 'md']], rainDays1: [['np_010', 'md']],
  precMax: [['p_max', 'md']], precMaxHi: [['p_max', 'max']],
  tmean: [['tm_mes', 'md']], tmax: [['tm_max', 'md']], tmin: [['tm_min', 'md']],
  tmaxAbs: [['ta_max', 'md']], tmaxHi: [['ta_max', 'max']], tminAbs: [['ta_min', 'md']], tminLo: [['ta_min', 'min']],
  hr: [['hr', 'md']],
  wind: [['w_med', 'md', 1 / 3.6]], // km/h → m/s (comprobado con la velocidad media diaria, que viene en m/s)
  gust: [['w_racha', 'md']], gustHi: [['w_racha', 'max']], // ya en m/s
  sun: [['inso', 'md']], // horas de sol al día
  snowDays: [['n_nie', 'md']], stormDays: [['n_tor', 'md']], fogDays: [['n_fog', 'md']], clearDays: [['n_des', 'md']],
  frostDays: [['nt_00', 'md']], hotDays: [['nt_30', 'md']]
};

/** '12.3' → 12.3; '' y '-' (sin dato) → null. */
function num(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (t === '' || t === '-') return null;
  const v = Number(t.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

/** Las 13 filas de la API (meses 01–12 y el año, «13») → normals, o null si no hay normales. */
export function parseNormals(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const by = {};
  for (const r of rows) { const m = parseInt(r && r.mes, 10); if (m >= 1 && m <= 13) by[m] = r; }
  const pick = (r, spec) => {
    if (!r) return null;
    for (const [v, s, k = 1] of spec) { const x = num(r[`${v}_${s}`]); if (x !== null) return r1(x * k); }
    return null;
  };
  const months = {}, year = {};
  for (const [key, spec] of Object.entries(NORMAL_SPEC)) {
    const arr = Array.from({ length: 12 }, (_, i) => pick(by[i + 1], spec));
    if (arr.some((x) => x !== null)) months[key] = arr;
    const y = pick(by[13], spec);
    if (y !== null) year[key] = y;
  }
  const Q = ['q1', 'q2', 'q3', 'q4'];
  const q = Q.map((s) => Array.from({ length: 12 }, (_, i) => { const x = num(by[i + 1] && by[i + 1][`p_mes_${s}`]); return x === null ? null : r1(x); }));
  if (q.some((a) => a.some((x) => x !== null))) months.precQ = q;
  const qy = Q.map((s) => { const x = num(by[13] && by[13][`p_mes_${s}`]); return x === null ? null : r1(x); });
  if (qy.some((x) => x !== null)) year.precQ = qy;
  if (!months.prec && !months.tmean) return null;
  const years = Object.values(by).map((r) => num(r.p_mes_n)).filter((x) => x !== null);
  return { period: '1991-2020', n: years.length ? Math.max(...years) : null, months, year };
}

// ---------------------------------------------------------------------------
// Récords (valores/climatologicos/valoresextremos/parametro/{P|T|V}/estacion/<id>)

// clave publicada, parámetro, valor, año, día (null: récord de un mes), mes del récord absoluto, factor, ¿0 = no hay récord?
const RECORD_SPEC = [
  ['precDay', 'P', 'precMaxDia', 'anioMaxDia', 'diaMaxDia', 'mesMaxDia', 0.1], // décimas de mm
  ['precHi', 'P', 'precMaxMen', 'anioMaxMen', null, 'mesMaxMen', 0.1],
  ['precLo', 'P', 'precMinMen', ['anioMinMes', 'anioMinMen'], null, 'mesMinMen', 0.1], // «IP» = inapreciable = 0
  ['rainDays', 'P', 'maxDiasMesPrec', 'anioMaxDiasMesPrec', null, 'mesMaxDiasMesPrec', 1],
  ['snowDays', 'P', 'maxDiasMesNieve', 'anioMaxDiasMesNieve', null, 'mesMaxDiasMesNieve', 1, true],
  ['stormDays', 'P', 'maxDiasMesTormenta', 'anioMaxDiasMesTormenta', null, 'mesMaxDiasMesTormenta', 1, true],
  ['tmaxHi', 'T', 'temMax', 'anioMax', 'diaMax', 'mesMax', 0.1], // décimas de °C
  ['tminLo', 'T', 'temMin', 'anioMin', 'diaMin', 'mesMin', 0.1],
  ['tmeanHi', 'T', 'temMedAlta', 'anioMedAlta', null, 'mesMedAlta', 0.1],
  ['tmeanLo', 'T', 'temMedBaja', 'anioMedBaja', null, 'mesMedBaja', 0.1],
  ['tmaxMeanHi', 'T', 'temMedMax', 'anioMedMax', null, 'mesMedMax', 0.1],
  ['tminMeanLo', 'T', 'temMedMin', 'anioMedMin', null, 'mesMedMin', 0.1],
  ['gustHi', 'V', 'rachMax', 'anio', 'dia', 'mes', 1 / 3.6] // km/h → m/s
];

const recNum = (s) => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim().toUpperCase();
  if (t === '' || t === '-') return null;
  if (t === 'IP') return 0;
  const v = Number(t.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};

/** Las respuestas de P, T y V (un objeto, o [] si no hay) → records ('aemet'), o null si no hay ninguno. */
export function parseRecords(parts) {
  const all = {}, month = {};
  for (const [key, par, val, yr, day, mon, scale, skipZero] of RECORD_SPEC) {
    let o = parts && parts[par];
    if (Array.isArray(o)) o = o[0];
    if (!o || typeof o !== 'object' || !Array.isArray(o[val])) continue;
    const yearArr = o[[].concat(yr).find((k) => Array.isArray(o[k]))];
    const dayArr = day ? o[day] : null;
    const entry = (i) => {
      const raw = recNum(o[val][i]);
      if (raw === null || (skipZero && raw === 0)) return null;
      const y = recNum(yearArr && yearArr[i]);
      let m = i < 12 ? i + 1 : recNum(o[mon]);
      if (!(m >= 1 && m <= 12) && yearArr) { // récord absoluto sin mes: el mes cuyo récord es el mismo
        const j = o[val].findIndex((x, k) => k < 12 && recNum(x) === raw && recNum(yearArr[k]) === y);
        m = j >= 0 ? j + 1 : null;
      }
      const d = dayArr ? recNum(dayArr[i]) : null;
      let date = null;
      if (y >= 1700 && y <= 2100) {
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        date = m >= 1 && m <= 12 ? (d >= 1 && d <= daysIn(mIdx(y, m - 1)) ? `${ym}-${String(d).padStart(2, '0')}` : ym) : String(y);
      }
      return [r1(raw * scale), date];
    };
    const per = Array.from({ length: 12 }, (_, i) => entry(i));
    const top = entry(12);
    if (per.some(Boolean)) month[key] = per;
    if (top) all[key] = top;
  }
  if (!Object.keys(all).length && !Object.keys(month).length) return null;
  return { source: 'aemet', all, month };
}

/** Récords calculados con nuestro histórico (cuando AEMET no los da): misma forma, source 'calculado'. */
export function computeRecords(v) {
  if (!v) return null;
  const base = mParse(v.m0), n = v.pN.length;
  const all = {}, month = {};
  const best = (key, cm, value, better, date) => { // value: número, better(a, b): ¿a mejora a b?
    const dst = cm === null ? all : (month[key] || (month[key] = new Array(12).fill(null)));
    const at = cm === null ? key : cm;
    if (dst[at] && !better(value, dst[at][0])) return;
    dst[at] = [value, date];
  };
  const hi = (a, b) => a > b, lo = (a, b) => a < b;
  const ymd = (idx, d) => `${mKey(idx)}-${String(d).padStart(2, '0')}`;
  for (let i = 0; i < n; i++) {
    const idx = base + i, cm = idx % 12, dim = daysIn(idx), full = 0.9 * dim;
    const both = (key, value, better, date) => { best(key, null, value, better, date); best(key, cm, value, better, date); };
    if (v.pXd[i]) both('precDay', v.pX[i] / 10, hi, ymd(idx, v.pXd[i]));
    if (v.xAd[i]) both('tmaxHi', v.xA[i] / 10, hi, ymd(idx, v.xAd[i]));
    if (v.nAd[i]) both('tminLo', v.nA[i] / 10, lo, ymd(idx, v.nAd[i]));
    if (v.gAd[i]) both('gustHi', v.gA[i] / 10, hi, ymd(idx, v.gAd[i]));
    if (v.pN[i] >= full) {
      both('precHi', v.pS[i] / 10, hi, mKey(idx));
      both('precLo', v.pS[i] / 10, lo, mKey(idx));
      both('rainDays', v.pR[i], hi, mKey(idx));
    }
    if (v.tN[i] >= full) { const m = Math.round(v.tS[i] / v.tN[i]) / 10; both('tmeanHi', m, hi, mKey(idx)); both('tmeanLo', m, lo, mKey(idx)); }
    if (v.xN[i] >= full) both('tmaxMeanHi', Math.round(v.xS[i] / v.xN[i]) / 10, hi, mKey(idx));
    if (v.nN[i] >= full) both('tminMeanLo', Math.round(v.nS[i] / v.nN[i]) / 10, lo, mKey(idx));
  }
  if (!Object.keys(all).length) return null;
  return { source: 'calculado', from: v.m0, all, month };
}

// ---------------------------------------------------------------------------
// Qué pedir a AEMET (normales y récords) y qué anotar

/** Estaciones a las que les toca (nunca pedidas, o con `next` vencido), las nuevas primero; hasta `max`. */
export function due(h, kind, ids, today, max) {
  const items = h[kind] || {};
  const list = [];
  for (const id of ids) {
    const it = items[id];
    if (!it) list.push(['', id]);
    else if (it.next <= today) list.push([it.next, id]);
  }
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return list.slice(0, max).map((x) => x[1]);
}

/** Anota las normales de una estación (rows: respuesta de la API); sin normales se reintenta en 30 días. */
export function setNormals(h, id, rows, today) {
  const v = parseNormals(rows);
  h.normals[id] = { v, next: addDays(today, v ? NORMALS_EVERY : RETRY_NONE) };
  return v;
}

/** Anota los récords de una estación (parts: {P, T, V}); sin récords se reintenta en 30 días. */
export function setRecords(h, id, parts, today) {
  const v = parseRecords(parts);
  h.records[id] = { v, next: addDays(today, v ? RECORDS_EVERY : RETRY_NONE) };
  return v;
}

/** Una petición falló: se conserva lo que hubiera y se reintenta mañana (si vuelve a fallar, en 2, 4… hasta 30 días). */
export function failItem(h, kind, id, today) {
  const it = h[kind][id];
  const fails = (it && it.fails) || 0;
  h[kind][id] = { v: it ? it.v : null, next: addDays(today, Math.min(RETRY_NONE, RETRY_ERROR * 2 ** fails)), fails: fails + 1 };
}

// ---------------------------------------------------------------------------
// Lo que se añade a la ficha de cada estación

export function stationExtras(h, arch, id) {
  const out = {};
  const view = combined(h, arch, id);
  if (view) out.history = monthlySeries(view, h.done);
  const n = h.normals[id];
  if (n && n.v) out.normals = n.v;
  const r = h.records[id];
  if (r && r.v) out.records = r.v;
  else if (h.done && view) { const c = computeRecords(view); if (c) out.records = c; }
  return out;
}

// ---------------------------------------------------------------------------
// Leer, comprobar y contar el archivo

/** Meses con datos sumando todas las estaciones: lo que no puede bajar entre una publicación y la siguiente. */
export function monthCount(h) {
  let n = 0;
  for (const st of Object.values(h.stations || {})) if (st.pN) for (let i = 0; i < st.pN.length; i++) if (hasMonth(st, i)) n++;
  return n;
}

/**
 * ¿Se publica lo nuevo? No, si tiene menos meses con datos (`after`) que lo
 * publicado antes (`before`): algo ha ido mal. Con `reset` sí. keep: true =
 * hay que conservar el archivo anterior tal cual.
 */
export function guardShrink(before, after, reset = false) {
  return { keep: !reset && after < before, before, after };
}

/** Comprueba la forma de lo leído (ante algo desconocido es mejor parar que empezar de cero). */
export function parseHistory(json) {
  if (!json || json.version !== 1 || typeof json.stations !== 'object') throw new Error('historico.json.gz: formato desconocido');
  return { ...emptyHistory(), ...json, normals: json.normals || {}, records: json.records || {} };
}

export function progress(h) {
  return {
    cursor: h.cursor, edge: h.edge, done: h.done, stations: Object.keys(h.stations).length, months: monthCount(h),
    normals: Object.values(h.normals).filter((x) => x.v).length, records: Object.values(h.records).filter((x) => x.v).length
  };
}

/**
 * Lee `rel` (p. ej. 'pluvio/archivo.json.gz') de `base`, una URL o una carpeta.
 * Devuelve {buf, json}, o null si no existe todavía (404 o ENOENT: primera vez).
 * Cualquier otro fallo se reintenta `tries` veces y, si sigue, se lanza el error:
 * el llamante debe parar antes de escribir nada.
 */
export async function loadGz(base, rel, io = {}) {
  const get = io.fetch || fetch, readFile = io.readFile || fs.readFile, tries = io.tries || 3;
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      let buf;
      if (/^https?:/.test(base)) {
        const res = await get(base.replace(/\/+$/, '') + '/' + rel, { headers: io.headers || {}, signal: AbortSignal.timeout(120000) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        try { buf = await readFile(path.join(base, rel)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      }
      return { buf, json: JSON.parse(gunzipSync(buf).toString('utf8')) };
    } catch (e) {
      last = e;
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw new Error(`${rel}: ${last && last.message}`);
}
