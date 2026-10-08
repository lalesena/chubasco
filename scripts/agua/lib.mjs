/*
 * Cálculos de los datos del agua (sin red), para scripts/agua/datos.mjs y
 * las pruebas.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { laea } = require('../../src/main/opera.js');

// Rejilla de la acumulación OPERA: 1900 × 2200 píxeles de 2 km en LAEA.
export const GRID = { width: 1900, height: 2200, originX: -1000, originY: 1000, size: 2000 };
const proj = laea({ lat0: 55, lon0: 10, falseEasting: 1950000, falseNorthing: -2100000 });
const MIN_COVER = 0.5; // por debajo, la hora de esa cuenca no cuenta

// ---------------------------------------------------------------------------
// Máscaras: qué píxeles de la rejilla caen en cada cuenca (relleno por filas
// del polígono proyectado, regla par-impar). Los límites simplificados se
// solapan un poco en las fronteras: cada píxel cuenta solo para una cuenca.

export function buildMasks(list) {
  const taken = new Uint8Array(GRID.width * GRID.height);
  const basins = list.map((b) => {
    const edges = [];
    let r0 = Infinity, r1 = -Infinity;
    for (const poly of b.polygons) {
      for (const ring of poly) {
        const pts = ring.map(([lon, lat]) => {
          const p = proj.forward(lat, lon);
          return [(p.e - GRID.originX) / GRID.size, (GRID.originY - p.n) / GRID.size]; // columna, fila continuas
        });
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], c = pts[(i + 1) % pts.length];
          if (a[1] === c[1]) continue;
          edges.push(a[1] < c[1] ? [a, c] : [c, a]);
          r0 = Math.min(r0, a[1], c[1]); r1 = Math.max(r1, a[1], c[1]);
        }
      }
    }
    const pixels = [];
    for (let r = Math.max(0, Math.floor(r0)); r <= Math.min(GRID.height - 1, Math.ceil(r1)); r++) {
      const y = r + 0.5;
      const xs = [];
      for (const [a, c] of edges) if (y >= a[1] && y < c[1]) xs.push(a[0] + ((y - a[1]) / (c[1] - a[1])) * (c[0] - a[0]));
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let col = Math.max(0, Math.ceil(xs[k] - 0.5)); col <= Math.min(GRID.width - 1, Math.floor(xs[k + 1] - 0.5)); col++) {
          const i = r * GRID.width + col;
          if (!taken[i]) { taken[i] = 1; pixels.push(i); }
        }
      }
    }
    return { id: b.id, pixels: Int32Array.from(pixels) };
  });
  let c0 = Infinity, c1 = -1, r0 = Infinity, r1 = -1;
  for (const b of basins) for (const i of b.pixels) {
    const r = Math.floor(i / GRID.width), c = i % GRID.width;
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  return { basins, window: { c0, c1, r0, r1 } };
}

/** Media de la cuenca para una hora: [mm, cobertura] (mm null si apenas hay datos). */
export function basinHour(get, masks) {
  const out = {};
  for (const b of masks.basins) {
    let sum = 0, n = 0;
    for (const i of b.pixels) { const v = get(i); if (!Number.isNaN(v)) { sum += v; n++; } }
    const cov = b.pixels.length ? n / b.pixels.length : 0;
    out[b.id] = [cov >= MIN_COVER ? Math.round((sum / n) * 100) / 100 : null, Math.round(cov * 100) / 100];
  }
  return out;
}

export function sumHours(list, scale, basins) {
  const out = {};
  for (const b of basins) {
    let mm = 0, n = 0, cov = 0;
    for (const x of list) { const v = x[b.id]; if (!v) continue; cov += v[1]; if (v[0] !== null) { mm += v[0]; n++; } }
    out[b.id] = [n >= list.length * 0.8 ? Math.round(mm * (list.length / n) * scale * 100) / 100 : null, Math.round((cov / list.length) * 100) / 100];
  }
  return out;
}

export function hydroYearStart(now) {
  const d = new Date(now * 1000);
  const y = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-10-01`;
}

// ---------------------------------------------------------------------------
// Embalses

export const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
export const num = (s) => Number(String(s).replace(',', '.')) || 0;

const DAY = 86400000, WEEK = 7 * DAY, YEAR = 365.2425 * DAY;

function parseRows(rows, list, log) {
  const byAmbito = new Map();
  for (const b of list) for (const a of b.ambitos) byAmbito.set(norm(a), b.id);
  const byDate = new Map();
  const unknown = new Set();
  for (const r of rows) {
    const id = byAmbito.get(norm(r.AMBITO_NOMBRE));
    if (!id) { unknown.add(r.AMBITO_NOMBRE); continue; }
    const t = new Date(r.FECHA).getTime();
    if (!byDate.has(t)) byDate.set(t, []);
    byDate.get(t).push({ basin: id, name: String(r.EMBALSE_NOMBRE).trim(), cap: num(r.AGUA_TOTAL), vol: num(r.AGUA_ACTUAL), elec: String(r.ELECTRICO_FLAG) === '1' });
  }
  if (unknown.size) log('embalses: ámbitos sin cuenca', [...unknown].join(', '));
  const dates = [...byDate.keys()].sort((a, b) => a - b);
  // La misma semana y años antes (por calendario): índice del boletín más
  // cercano, o -1 si no lo hay a menos de 4 días.
  const sameWeek = (i, y) => {
    const t = dates[i] - y * YEAR;
    let lo = 0, hi = dates.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(dates[lo - 1] - t) <= Math.abs(dates[lo] - t)) lo--;
    return Math.abs(dates[lo] - t) <= 4 * DAY ? lo : -1;
  };
  // Último año (semanal), más una semana para cerrar el año.
  const last = dates.length - 1;
  const recent = [];
  for (let i = 0; i <= last; i++) if (dates[i] > dates[last] - YEAR - WEEK) recent.push(i);
  return { dates, byDate, sameWeek, recent };
}

/**
 * Resumen del Boletín Hidrológico: filas {AMBITO_NOMBRE, EMBALSE_NOMBRE,
 * FECHA, AGUA_TOTAL, AGUA_ACTUAL, ELECTRICO_FLAG} → reserva por cuenca.
 */
export function summarizeReservoirs(rows, list, log = () => {}) {
  const { dates, byDate, sameWeek, recent: recentIdx } = parseRows(rows, list, log);
  const iLast = dates.length - 1;
  const last = dates[iLast];
  const prev = dates[iLast - 1];
  const ago = (i, y) => { const j = sameWeek(i, y); return j < 0 ? null : dates[j]; };
  const cache = new Map();
  const totals = (t) => {
    if (cache.has(t)) return cache.get(t);
    const out = { all: { cap: 0, vol: 0 } };
    for (const x of byDate.get(t) || []) {
      const b = out[x.basin] || (out[x.basin] = { cap: 0, vol: 0, n: 0 });
      b.cap += x.cap; b.vol += x.vol; b.n++;
      out.all.cap += x.cap; out.all.vol += x.vol;
    }
    cache.set(t, out);
    return out;
  };
  const pct = (o) => (o && o.cap ? Math.round((1000 * o.vol) / o.cap) / 10 : null);
  const now = totals(last), before = totals(prev), lastYear = totals(ago(iLast, 1));
  // Media de los 10 años anteriores en la misma semana.
  const avgAt = (i, id) => {
    const v = [];
    for (let y = 1; y <= 10; y++) { const d = ago(i, y); const p = d === null ? null : pct(totals(d)[id]); if (p !== null) v.push(p); }
    return v.length >= 5 ? Math.round((10 * v.reduce((s, x) => s + x, 0)) / v.length) / 10 : null;
  };
  const avg10 = (id) => avgAt(iLast, id);
  // Evolución en el último año (semanal) y la media de 10 años de cada semana.
  const recent = recentIdx.map((i) => dates[i]);
  const weeks = (id) => ({ weeks: recent.map((d) => pct(totals(d)[id])), weeksAvg: recentIdx.map((i) => avgAt(i, id)) });

  const prevVol = new Map((byDate.get(prev) || []).map((x) => [`${x.basin}|${x.name}`, x.vol]));
  const basins = {};
  for (const b of list) {
    const c = now[b.id];
    if (!c) continue;
    basins[b.id] = {
      cap: Math.round(c.cap), vol: Math.round(c.vol), pct: pct(c),
      prevPct: pct(before[b.id]), lastYearPct: pct(lastYear[b.id]), avg10Pct: avg10(b.id), n: c.n, ...weeks(b.id),
      list: (byDate.get(last) || []).filter((x) => x.basin === b.id).sort((x, y) => y.cap - x.cap)
        .map((x) => ({ name: x.name, cap: Math.round(x.cap), vol: Math.round(x.vol), prev: prevVol.has(`${b.id}|${x.name}`) ? Math.round(prevVol.get(`${b.id}|${x.name}`)) : null, elec: x.elec || undefined }))
    };
  }
  const out = {
    date: new Date(last).toISOString().slice(0, 10),
    weekDates: recent.map((d) => new Date(d).toISOString().slice(0, 10)),
    total: { cap: Math.round(now.all.cap), vol: Math.round(now.all.vol), pct: pct(now.all), prevPct: pct(before.all), lastYearPct: pct(lastYear.all), avg10Pct: avg10('all'), ...weeks('all') },
    basins
  };
  return out;
}

/**
 * Histórico de cada embalse (para su ficha), por cuenca:
 * {id: {date, weekDates, total: {m0, m}, res: {nombre: {...}}}}, con
 *  - w, avg, lo, hi: % de cada semana del último año, media de los 10 años
 *    anteriores y mínimo y máximo de todos los años anteriores;
 *  - y0, yrs: % de esta misma semana en cada año desde y0;
 *  - m0, m: media mensual desde el primer dato (% entero);
 *  - max, min: [%, fecha] récords de toda la serie; since: primer dato.
 * Solo los embalses del último boletín.
 */
export function reservoirHistory(rows, list, log = () => {}) {
  const { dates, byDate, sameWeek, recent } = parseRows(rows, list, log);
  const n = dates.length, iLast = n - 1;
  const iso = (i) => new Date(dates[i]).toISOString().slice(0, 10);
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const r0 = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const d0 = new Date(dates[0]);
  const month = (i) => { const d = new Date(dates[i]); return (d.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d.getUTCMonth() - d0.getUTCMonth(); };
  const monthKey = (k) => { const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1)); return d.toISOString().slice(0, 7); };

  // Serie (%) de cada embalse y totales de cada cuenca.
  const series = new Map();
  const totals = new Map();
  for (let i = 0; i < n; i++) {
    for (const x of byDate.get(dates[i])) {
      const key = `${x.basin}|${x.name}`;
      let s = series.get(key);
      if (!s) { s = { basin: x.basin, name: x.name, pct: new Float32Array(n).fill(NaN) }; series.set(key, s); }
      if (x.cap > 0) s.pct[i] = (100 * x.vol) / x.cap;
      let tt = totals.get(x.basin);
      if (!tt) { tt = { cap: new Float64Array(n), vol: new Float64Array(n) }; totals.set(x.basin, tt); }
      tt.cap[i] += x.cap; tt.vol[i] += x.vol;
    }
  }
  // Las semanas equivalentes de años anteriores, una vez para todos.
  const back = new Map();
  const years = Math.floor((dates[iLast] - dates[0]) / YEAR);
  for (const i of recent) { const js = []; for (let y = 1; y <= years; y++) js.push(sameWeek(i, y)); back.set(i, js); }
  const at = (p, j) => (j >= 0 && Number.isFinite(p[j]) ? p[j] : null);

  const monthly = (p) => {
    const sum = [], cnt = [];
    let first = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(p[i])) continue;
      const k = month(i);
      if (first < 0) first = k;
      sum[k] = (sum[k] || 0) + p[i]; cnt[k] = (cnt[k] || 0) + 1;
    }
    if (first < 0) return { m0: null, m: [] };
    const m = [];
    for (let k = first; k <= month(iLast); k++) m.push(cnt[k] ? Math.round(sum[k] / cnt[k]) : null);
    return { m0: monthKey(first), m };
  };

  const out = {};
  for (const b of list) out[b.id] = { date: iso(iLast), weekDates: recent.map(iso), total: { m0: null, m: [] }, res: {} };
  for (const [id, tt] of totals) {
    if (!out[id]) continue;
    const p = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (tt.cap[i] > 0) p[i] = (100 * tt.vol[i]) / tt.cap[i];
    out[id].total = monthly(p);
  }
  for (const s of series.values()) {
    const p = s.pct;
    if (!Number.isFinite(p[iLast]) || !out[s.basin]) continue;
    const prior = (i) => back.get(i).map((j) => at(p, j)).filter((v) => v !== null);
    const w = [], avg = [], lo = [], hi = [];
    for (const i of recent) {
      w.push(r1(p[i]));
      const ten = back.get(i).slice(0, 10).map((j) => at(p, j)).filter((v) => v !== null);
      avg.push(ten.length >= 5 ? r1(ten.reduce((a, v) => a + v, 0) / ten.length) : null);
      const all = prior(i);
      lo.push(all.length >= 5 ? r0(Math.min(...all)) : null);
      hi.push(all.length >= 5 ? r0(Math.max(...all)) : null);
    }
    // Esta semana en cada año, del más antiguo al actual.
    const same = back.get(iLast).map((j) => at(p, j)).reverse();
    const lead = same.findIndex((v) => v !== null);
    const yrs = lead < 0 ? [] : same.slice(lead).map(r1);
    let iMax = -1, iMin = -1, iFirst = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(p[i])) continue;
      if (iFirst < 0) iFirst = i;
      if (iMax < 0 || p[i] > p[iMax]) iMax = i;
      if (iMin < 0 || p[i] < p[iMin]) iMin = i;
    }
    out[s.basin].res[s.name] = {
      w, avg, lo, hi,
      y0: new Date(dates[iLast]).getUTCFullYear() - yrs.length, yrs,
      ...monthly(p),
      max: [r1(p[iMax]), iso(iMax)], min: [r1(p[iMin]), iso(iMin)], since: iso(iFirst)
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pluviómetros (AEMET, observación convencional): `prec` es la lluvia de los
// 60 minutos anteriores a `fint`. El estado guarda la lista de estaciones
// (ids, y nombre y posición en meta), la lluvia de cada hora de las últimas
// GAUGE_HOURS horas (un valor por estación, en el orden de ids) y la de cada
// día UTC completo (los 32 últimos).

const GAUGE_HOURS = 50, GAUGE_DAYS = 32, HOUR_MS = 3600000;
const gaugeHourKey = (t) => new Date(t).toISOString().slice(0, 13); // '2026-10-08T09' = hora que termina a las 09:00 UTC
const isoTime = (s) => Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));

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

/** Añade las observaciones (filas de AEMET) al estado y rehace los días que aún se pueden completar. */
export function gaugeIngest(prev, rows, now) {
  const st = { ids: [...((prev && prev.ids) || [])], meta: { ...((prev && prev.meta) || {}) }, hours: { ...((prev && prev.hours) || {}) }, days: { ...((prev && prev.days) || {}) } };
  const index = new Map(st.ids.map((id, i) => [id, i]));
  for (const r of rows) {
    if (!r || !r.idema || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    let i = index.get(r.idema);
    if (i === undefined) { i = st.ids.length; st.ids.push(r.idema); index.set(r.idema, i); }
    st.meta[r.idema] = [gaugeName(r.ubi || r.idema), Math.round(r.lat * 1e4) / 1e4, Math.round(r.lon * 1e4) / 1e4];
    const t = isoTime(r.fint);
    if (typeof r.prec !== 'number' || !(r.prec >= 0) || r.prec > 250 || !Number.isFinite(t) || t % HOUR_MS) continue;
    const arr = st.hours[gaugeHourKey(t)] || (st.hours[gaugeHourKey(t)] = []);
    arr[i] = Math.round(r.prec * 10) / 10;
  }
  const oldest = Math.floor(now / HOUR_MS) * HOUR_MS - GAUGE_HOURS * HOUR_MS;
  for (const k of Object.keys(st.hours)) if (Date.parse(k + ':00:00Z') <= oldest) delete st.hours[k];
  // Días UTC: la lluvia de las horas que terminan entre las 01:00 y las 24:00.
  // Se rehacen mientras sus horas sigan guardadas (pueden llegar tarde).
  const today = Math.floor(now / 86400000) * 86400000;
  for (let d = today - 86400000; d + HOUR_MS > oldest; d -= 86400000) {
    const sum = [], n = [];
    for (let h = 1; h <= 24; h++) {
      const arr = st.hours[gaugeHourKey(d + h * HOUR_MS)];
      if (!arr) continue;
      arr.forEach((v, i) => { if (v !== null && v !== undefined) { sum[i] = (sum[i] || 0) + v; n[i] = (n[i] || 0) + 1; } });
    }
    const day = st.ids.map((_, i) => (n[i] >= 22 ? Math.round(sum[i] * 10) / 10 : null));
    if (day.some((v) => v !== null)) st.days[new Date(d).toISOString().slice(0, 10)] = day;
  }
  for (const k of Object.keys(st.days)) if (Date.parse(k) < today - GAUGE_DAYS * 86400000) delete st.days[k];
  return st;
}

/** Lo que se publica: {until, stations: [[id, nombre, lat, lon, h1, h24, d7, d30]]}. */
export function gaugeSummary(st, now) {
  const keys = Object.keys(st.hours || {}).sort();
  if (!keys.length) return null;
  const latest = keys[keys.length - 1];
  const tLatest = Date.parse(latest + ':00:00Z');
  const today = Math.floor(now / 86400000) * 86400000;
  const r1 = (v) => Math.round(v * 10) / 10;
  const at = (k, i) => { const a = st.hours[k]; const v = a ? a[i] : undefined; return v === null || v === undefined ? null : v; };
  const stations = [];
  st.ids.forEach((id, i) => {
    const meta = st.meta[id];
    if (!meta) return;
    let h24 = 0, n24 = 0, todaySum = 0;
    for (let h = 0; h < 24; h++) {
      const t = tLatest - h * HOUR_MS;
      const v = at(gaugeHourKey(t), i);
      if (v === null) continue;
      h24 += v; n24++;
      if (t > today) todaySum += v;
    }
    const days = (count) => {
      let mm = todaySum, got = 0;
      for (let k = 1; k < count; k++) { const a = st.days[new Date(today - k * 86400000).toISOString().slice(0, 10)]; const v = a ? a[i] : null; if (v !== null && v !== undefined) { mm += v; got++; } }
      return got >= (count - 1) * 0.9 ? r1(mm) : null;
    };
    const h1 = at(latest, i) ?? at(gaugeHourKey(tLatest - HOUR_MS), i); // algunas estaciones llegan una hora tarde
    const row = [id, meta[0], meta[1], meta[2], h1, n24 >= 22 ? r1(h24) : null, days(7), days(30)];
    if (row[4] !== null || row[5] !== null) stations.push(row);
  });
  return { until: new Date(tLatest).toISOString(), stations };
}
