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

/**
 * Resumen del Boletín Hidrológico: filas {AMBITO_NOMBRE, EMBALSE_NOMBRE,
 * FECHA, AGUA_TOTAL, AGUA_ACTUAL, ELECTRICO_FLAG} → reserva por cuenca.
 */
export function summarizeReservoirs(rows, list, log = () => {}) {
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
  const last = dates[dates.length - 1];
  const prev = dates[dates.length - 2];
  const closest = (t) => dates.reduce((best, d) => (Math.abs(d - t) < Math.abs(best - t) ? d : best), dates[0]);
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
  const week = 7 * 86400000, year = 364 * 86400000;
  const now = totals(last), before = totals(prev), lastYear = totals(closest(last - year));
  // Media de los 10 años anteriores en la misma semana.
  const avgAt = (t, id) => {
    const v = [];
    for (let y = 1; y <= 10; y++) {
      const d = closest(t - y * year);
      if (Math.abs(d - (t - y * year)) <= week) { const p = pct(totals(d)[id]); if (p !== null) v.push(p); }
    }
    return v.length >= 5 ? Math.round((10 * v.reduce((s, x) => s + x, 0)) / v.length) / 10 : null;
  };
  const avg10 = (id) => avgAt(last, id);
  // Evolución en el último año (semanal) y la media de 10 años de cada semana.
  const recent = dates.filter((d) => d > last - year - week);
  const weeks = (id) => ({ weeks: recent.map((d) => pct(totals(d)[id])), weeksAvg: recent.map((d) => avgAt(d, id)) });

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
