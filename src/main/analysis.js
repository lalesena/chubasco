// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
/*
 * Análisis de imágenes de radar: proyección, rejillas de intensidad,
 * estadísticas alrededor de una ubicación, estimación del movimiento de la
 * lluvia entre fotogramas y extrapolación a corto plazo (nowcast).
 *
 * Todo es puro (sin red ni Electron) para poder probarlo con `npm test`.
 */
const P = require('../shared/palette');

// Rejilla de análisis en Web Mercator: un mundo de 512 px a zoom 6 da
// ~1 km por píxel, de sobra para una alarma.
const TILE_SIZE = 512;
const ZOOM = 6;
const WORLD = TILE_SIZE * Math.pow(2, ZOOM);
const EARTH_CIRC = 40075016.686;
const DEG = Math.PI / 180;

function project(lat, lon) {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG);
  return {
    x: ((lon + 180) / 360) * WORLD,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD
  };
}

function unproject(x, y) {
  const lon = (x / WORLD) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / WORLD;
  const lat = Math.atan(Math.sinh(n)) / DEG;
  return { lat, lon };
}

function metersPerPixel(lat) {
  return (EARTH_CIRC * Math.cos(lat * DEG)) / WORLD;
}

/**
 * Caja de píxeles (en el mundo de zoom 6 / 512 px) centrada en la ubicación.
 */
function boxFor(lat, lon, radiusKm) {
  const c = project(lat, lon);
  const mpp = metersPerPixel(lat);
  const half = Math.ceil((radiusKm * 1000) / mpp);
  const x0 = Math.floor(c.x) - half;
  const y0 = Math.floor(c.y) - half;
  const size = half * 2 + 1;
  return {
    lat, lon, radiusKm, mpp, x0, y0, w: size, h: size,
    cx: c.x - x0, cy: c.y - y0,
    key: `${x0}:${y0}:${size}`
  };
}

function bearingDeg(dx, dy) {
  // dx hacia el este, dy hacia el sur (coordenadas de imagen).
  const b = Math.atan2(dx, -dy) / DEG;
  return (b + 360) % 360;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------
// Limpieza: motas sueltas y ecos fijos (tierra, aerogeneradores, mar).

/** Área mínima de una mancha de lluvia (km²); por debajo suele ser ruido. */
const MIN_ECHO_KM2 = 4;

function minPixelsFor(box, km2 = MIN_ECHO_KM2) {
  return Math.max(2, Math.round(km2 / Math.pow(box.mpp / 1000, 2)));
}

/** Componentes conexas (8 vecinos) de los píxeles con dBZ ≥ thr. */
function components(grid, thr) {
  const { w, h, dbz } = grid;
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] !== -1 || !(dbz[i] >= thr)) continue;
    const id = sizes.length;
    let sp = 0, count = 0;
    stack[sp++] = i;
    label[i] = id;
    while (sp) {
      const j = stack[--sp];
      count++;
      const x = j % w, y = (j - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (label[k] === -1 && dbz[k] >= thr) { label[k] = id; stack[sp++] = k; }
        }
      }
    }
    sizes.push(count);
  }
  return { label, sizes };
}

/**
 * Copia de la rejilla sin los píxeles de `clutter` (1 = eco fijo) ni las
 * manchas ≥ thresholdDbz más pequeñas que minPx. Lo que está por debajo del
 * umbral se conserva.
 */
function cleanGrid(grid, { thresholdDbz, minPx, clutter = null }) {
  const n = grid.w * grid.h;
  const dbz = new Float32Array(grid.dbz);
  const kind = new Uint8Array(grid.kind);
  let removed = 0;
  if (clutter) {
    for (let i = 0; i < n; i++) {
      if (clutter[i] && dbz[i] >= 10) { dbz[i] = NaN; kind[i] = 0; removed++; }
    }
  }
  const { label, sizes } = components({ w: grid.w, h: grid.h, dbz }, thresholdDbz);
  for (let i = 0; i < n; i++) {
    const l = label[i];
    if (l >= 0 && sizes[l] < minPx) { dbz[i] = NaN; kind[i] = 0; removed++; }
  }
  return { ...grid, dbz, kind, removed };
}

/**
 * Ecos fijos a corto plazo: píxeles con eco en todos los fotogramas, casi sin
 * cambiar de intensidad y dentro de manchas pequeñas. Solo tiene sentido
 * buscarlos cuando la lluvia de alrededor se mueve. Uint8Array o null.
 */
function staticEchoes(grids, box, { maxAreaKm2 = 60, maxDeltaDbz = 3 } = {}) {
  const gs = grids.filter(Boolean);
  if (gs.length < 3) return null;
  const last = gs[gs.length - 1];
  const n = last.w * last.h;
  const maxPx = minPixelsFor(box, maxAreaKm2);
  const { label, sizes } = components(last, 10);
  const out = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const l = label[i];
    if (l < 0 || sizes[l] > maxPx) continue;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (const g of gs) {
      const v = g.dbz[i];
      if (!(v >= 10)) { ok = false; break; }
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (ok && hi - lo <= maxDeltaDbz) { out[i] = 1; count++; }
  }
  return count ? out : null;
}

/** Máximo dBZ dentro de un radio (en píxeles) alrededor de (px, py). */
function probe(grid, px, py, rPx) {
  let best = NaN;
  let bestKind = 0;
  let inside = false;
  const r2 = rPx * rPx;
  const xa = Math.floor(px - rPx), xb = Math.ceil(px + rPx);
  const ya = Math.floor(py - rPx), yb = Math.ceil(py + rPx);
  for (let y = ya; y <= yb; y++) {
    if (y < 0 || y >= grid.h) continue;
    for (let x = xa; x <= xb; x++) {
      if (x < 0 || x >= grid.w) continue;
      const dx = x - px, dy = y - py;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * grid.w + x;
      if (grid.kind[i] === 255) continue;
      inside = true;
      const v = grid.dbz[i];
      if (isFinite(v) && !(v <= best)) { best = v; bestKind = grid.kind[i]; }
    }
  }
  return { inside, dbz: best, kind: bestKind };
}

/**
 * Estadísticas de la rejilla respecto a la ubicación.
 */
function locationStats(grid, box, { alarmRadiusKm, thresholdDbz, probeKm = 2, searchRadiusKm = alarmRadiusKm }) {
  const rAlarm = (alarmRadiusKm * 1000) / box.mpp;
  const rProbe = Math.max(1, (probeKm * 1000) / box.mpp);
  const at = probe(grid, box.cx, box.cy, rProbe);

  let nearest = null;
  let nearestD2 = Infinity;
  let maxDbz = NaN;
  let maxKind = 0;
  let strongest = null; // núcleo más intenso en toda la zona analizada
  let total = 0, wet = 0, missing = 0;
  const r2 = rAlarm * rAlarm;
  const rSearch = Math.max(rAlarm, (searchRadiusKm * 1000) / box.mpp);
  const rs2 = rSearch * rSearch;
  for (let y = 0; y < grid.h; y++) {
    const dy = y - box.cy;
    if (dy * dy > rs2) continue;
    for (let x = 0; x < grid.w; x++) {
      const dx = x - box.cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > rs2) continue;
      const i = y * grid.w + x;
      const inAlarm = d2 <= r2;
      if (inAlarm) total++;
      if (grid.kind[i] === 255) { if (inAlarm) missing++; continue; }
      const v = grid.dbz[i];
      if (!(v >= thresholdDbz)) continue;
      if (!strongest || v > strongest.dbz || (v === strongest.dbz && d2 < strongest.d2)) strongest = { dbz: v, kind: grid.kind[i], dx, dy, d2 };
      if (inAlarm) {
        wet++;
        if (!(v <= maxDbz)) { maxDbz = v; maxKind = grid.kind[i]; }
      }
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearest = { dx, dy, dbz: v, kind: grid.kind[i] };
      }
    }
  }

  let nearestOut = null;
  if (nearest) {
    // Intensidad representativa: máximo en 3 km alrededor del eco más cercano.
    const around = probe(grid, box.cx + nearest.dx, box.cy + nearest.dy, (3000 / box.mpp));
    nearestOut = {
      distanceKm: (Math.sqrt(nearestD2) * box.mpp) / 1000,
      bearingDeg: bearingDeg(nearest.dx, nearest.dy),
      dbz: isFinite(around.dbz) ? around.dbz : nearest.dbz,
      kind: around.kind || nearest.kind
    };
  }
  const nearestIn = nearestOut && nearestD2 <= r2 ? nearestOut : null;

  return {
    atLocation: { dbz: isFinite(at.dbz) ? at.dbz : null, kind: at.kind, hasData: at.inside },
    nearest: nearestIn,
    nearestAny: nearestOut,
    maxInRadius: isFinite(maxDbz) ? { dbz: maxDbz, kind: maxKind } : null,
    strongest: strongest && {
      dbz: strongest.dbz, kind: strongest.kind,
      distanceKm: (Math.sqrt(strongest.d2) * box.mpp) / 1000, bearingDeg: bearingDeg(strongest.dx, strongest.dy)
    },
    wetFraction: total ? wet / total : 0,
    missingFraction: total ? missing / total : 1
  };
}

// ---------------------------------------------------------------------------
// Movimiento: correlación cruzada normalizada entre dos fotogramas.

function fieldOf(grid, f) {
  // Campo de intensidad (dBZ por encima de 10) reducido por un factor f
  // (media por bloques).
  const w = Math.floor(grid.w / f), h = Math.floor(grid.h / f);
  const out = new Float32Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) {
        const row = (y * f + yy) * grid.w + x * f;
        for (let xx = 0; xx < f; xx++) {
          const v = grid.dbz[row + xx];
          if (v >= 10) s += v - 5;
        }
      }
      const val = s / (f * f);
      out[y * w + x] = val;
      if (val > 0) count++;
    }
  }
  return { w, h, v: out, count };
}

function ncc(a, b, sx, sy, win) {
  // Correlación de a(x, y) con b(x + sx, y + sy) sobre la zona solapada
  // (opcionalmente limitada a una ventana de a).
  let sab = 0, saa = 0, sbb = 0;
  const x0 = Math.max(win ? win.x0 : 0, -sx), x1 = Math.min(win ? win.x1 : a.w, b.w - sx);
  const y0 = Math.max(win ? win.y0 : 0, -sy), y1 = Math.min(win ? win.y1 : a.h, b.h - sy);
  if (x1 - x0 < 4 || y1 - y0 < 4) return -1;
  for (let y = y0; y < y1; y++) {
    const ra = y * a.w, rb = (y + sy) * b.w + sx;
    for (let x = x0; x < x1; x++) {
      const va = a.v[ra + x], vb = b.v[rb + x];
      if (va === 0 && vb === 0) continue;
      sab += va * vb; saa += va * va; sbb += vb * vb;
    }
  }
  if (saa === 0 || sbb === 0) return -1;
  return sab / Math.sqrt(saa * sbb);
}

function searchBest(a, b, cx, cy, range, win) {
  let best = -2, bx = cx, by = cy;
  const scores = new Map();
  for (let sy = cy - range; sy <= cy + range; sy++) {
    for (let sx = cx - range; sx <= cx + range; sx++) {
      const s = ncc(a, b, sx, sy, win);
      scores.set(`${sx},${sy}`, s);
      if (s > best) { best = s; bx = sx; by = sy; }
    }
  }
  return { best, bx, by, scores };
}

function subpixel(scores, bx, by) {
  const g = (x, y) => scores.get(`${x},${y}`);
  const fit = (m, c, p) => {
    if (m === undefined || p === undefined || m < -1 || p < -1) return 0;
    const den = m - 2 * c + p;
    if (den >= 0) return 0;
    return Math.max(-0.5, Math.min(0.5, 0.5 * (m - p) / den));
  };
  const c = g(bx, by);
  return { ox: fit(g(bx - 1, by), c, g(bx + 1, by)), oy: fit(g(bx, by - 1), c, g(bx, by + 1)) };
}

/**
 * Desplazamiento de la lluvia de gridA (antes) a gridB (después).
 * Devuelve velocidad en píxeles/minuto o null si no hay ecos suficientes.
 */
function estimateMotion(gridA, gridB, box, dtMin, { maxSpeedKmh = 130 } = {}) {
  if (!(dtMin > 0)) return null;
  const maxShiftPx = ((maxSpeedKmh / 60) * dtMin * 1000) / box.mpp;
  const f = Math.max(1, Math.ceil(Math.max(gridA.w, gridA.h) / 110));
  const ca = fieldOf(gridA, f), cb = fieldOf(gridB, f);
  if (ca.count < 6 || cb.count < 6) return null;
  const coarseRange = Math.max(2, Math.ceil(maxShiftPx / f));
  const coarse = searchBest(ca, cb, 0, 0, coarseRange);
  if (coarse.best < 0.15) return null;

  let bx = coarse.bx * f, by = coarse.by * f, score = coarse.best, scores = coarse.scores;
  let sp = subpixel(scores, coarse.bx, coarse.by);
  let fine = 1;
  if (f > 1) {
    const ff = Math.max(1, Math.floor(f / 2));
    const fa = fieldOf(gridA, ff), fb = fieldOf(gridB, ff);
    const r = searchBest(fa, fb, Math.round(bx / ff), Math.round(by / ff), Math.ceil(f / ff) + 1);
    if (r.best > -1) {
      bx = r.bx * ff; by = r.by * ff; score = r.best; scores = r.scores; fine = ff;
      sp = subpixel(scores, r.bx, r.by);
    }
  }
  const sx = bx + sp.ox * fine;
  const sy = by + sp.oy * fine;
  // Mejora respecto a "no se mueve": si es mínima, la tratamos como quieta.
  const still = ncc(fieldOf(gridA, fine), fieldOf(gridB, fine), 0, 0);
  return {
    vx: sx / dtMin, vy: sy / dtMin, score,
    gain: score - Math.max(0, still),
    echoes: Math.min(ca.count, cb.count)
  };
}

/** Promedio ponderado de varias estimaciones; confianza 0..1. */
function combineMotion(list, box) {
  const ok = list.filter(Boolean);
  if (!ok.length) return null;
  let sw = 0, vx = 0, vy = 0, sAmb = 0;
  for (const m of ok) {
    // Si el vector apenas mejora a "no se mueve", es dudoso: pesa menos.
    const amb = clamp((m.gain === undefined ? 0.05 : m.gain) / 0.05, 0, 1);
    const w = Math.max(0.01, m.score) * Math.min(1, m.echoes / 40) * (0.3 + 0.7 * amb);
    sw += w; vx += m.vx * w; vy += m.vy * w; sAmb += amb;
  }
  vx /= sw; vy /= sw;
  let spread = 0;
  for (const m of ok) spread += Math.hypot(m.vx - vx, m.vy - vy);
  spread /= ok.length;
  const speed = Math.hypot(vx, vy);
  const meanScore = ok.reduce((s, m) => s + m.score, 0) / ok.length;
  const consistency = ok.length > 1 ? Math.max(0, 1 - spread / Math.max(speed, 0.15)) : 0.6;
  const clarity = 0.6 + 0.4 * (sAmb / ok.length);
  const confidence = clamp(meanScore * (0.5 + 0.5 * consistency) * Math.min(1, ok.length / 2) * clarity, 0, 1);
  const mpm = box.mpp; // metros por píxel
  return {
    vx, vy,
    spreadPx: spread, // px/min: cuánto discrepan los pares de fotogramas
    vEast: vx * mpm, vNorth: -vy * mpm, // m/min
    speedKmh: (speed * mpm * 60) / 1000,
    headingDeg: bearingDeg(vx, vy), // hacia dónde va
    confidence,
    samples: ok.length
  };
}

// ---------------------------------------------------------------------------
// Movimiento por zonas: una rejilla nb×nb de ventanas solapadas. En cada una
// se busca el desplazamiento cerca del global; las zonas con pocos ecos
// heredan el global. Así dos líneas de tormenta pueden moverse distinto.

function blockWindows(w, h, nb) {
  const out = [];
  const hw = w / (nb + 1), hh = h / (nb + 1);
  for (let j = 0; j < nb; j++) {
    for (let i = 0; i < nb; i++) {
      const cx = ((i + 0.5) / nb) * w, cy = ((j + 0.5) / nb) * h;
      out.push({
        x0: Math.max(0, Math.floor(cx - hw)), x1: Math.min(w, Math.ceil(cx + hw)),
        y0: Math.max(0, Math.floor(cy - hh)), y1: Math.min(h, Math.ceil(cy + hh))
      });
    }
  }
  return out;
}

function estimateMotionField(gridA, gridB, box, dtMin, pair, { nb = 3, maxDevKmh = 25, minEchoKm2 = 150 } = {}) {
  if (!pair || !(dtMin > 0)) return null;
  const f = Math.max(1, Math.floor(Math.max(gridA.w, gridA.h) / 120));
  const fa = fieldOf(gridA, f), fb = fieldOf(gridB, f);
  const cx = Math.round((pair.vx * dtMin) / f), cy = Math.round((pair.vy * dtMin) / f);
  const range = Math.max(2, Math.ceil(((maxDevKmh / 60) * dtMin * 1000) / box.mpp / f));
  const minPx = Math.max(12, Math.round(minEchoKm2 / Math.pow((box.mpp * f) / 1000, 2)));
  const wins = blockWindows(fa.w, fa.h, nb);
  const lx = new Float32Array(nb * nb), ly = new Float32Array(nb * nb), alpha = new Float32Array(nb * nb);
  wins.forEach((win, k) => {
    lx[k] = pair.vx; ly[k] = pair.vy;
    let echoes = 0;
    for (let y = win.y0; y < win.y1; y++) {
      for (let x = win.x0; x < win.x1; x++) if (fa.v[y * fa.w + x] > 0) echoes++;
    }
    if (echoes < minPx) return;
    const r = searchBest(fa, fb, cx, cy, range, win);
    if (r.best < 0.3) return;
    const sp = subpixel(r.scores, r.bx, r.by);
    lx[k] = ((r.bx + sp.ox) * f) / dtMin;
    ly[k] = ((r.by + sp.oy) * f) / dtMin;
    alpha[k] = Math.min(1, (r.best - 0.3) / 0.4) * Math.min(1, echoes / (minPx * 4));
  });
  return { nb, w: gridA.w, h: gridA.h, lx, ly, alpha };
}

/** Une los campos de varios pares y los mezcla con el vector global. */
function combineFields(fields, global) {
  const ok = fields.filter(Boolean);
  if (!ok.length || !global) return null;
  const nb = ok[0].nb, n = nb * nb;
  const vx = new Float32Array(n), vy = new Float32Array(n), alpha = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let sw = 0, sx = 0, sy = 0;
    for (const f of ok) { const w = f.alpha[k]; sw += w; sx += f.lx[k] * w; sy += f.ly[k] * w; }
    const a = sw / ok.length;
    const lx = sw > 0 ? sx / sw : global.vx, ly = sw > 0 ? sy / sw : global.vy;
    vx[k] = a * lx + (1 - a) * global.vx;
    vy[k] = a * ly + (1 - a) * global.vy;
    alpha[k] = a;
  }
  return { nb, w: ok[0].w, h: ok[0].h, vx, vy, alpha };
}

/** Interpolación bilineal entre los centros de las zonas. */
function interpBlocks(nb, w, h, arr, x, y) {
  const u = clamp((x / w) * nb - 0.5, 0, nb - 1);
  const v = clamp((y / h) * nb - 0.5, 0, nb - 1);
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const i1 = Math.min(nb - 1, i0 + 1), j1 = Math.min(nb - 1, j0 + 1);
  const fx = u - i0, fy = v - j0;
  const top = arr[j0 * nb + i0] * (1 - fx) + arr[j0 * nb + i1] * fx;
  const bot = arr[j1 * nb + i0] * (1 - fx) + arr[j1 * nb + i1] * fx;
  return top * (1 - fy) + bot * fy;
}

function velocityAt(field, motion, x, y) {
  if (!field) return { vx: motion.vx, vy: motion.vy };
  return { vx: interpBlocks(field.nb, field.w, field.h, field.vx, x, y), vy: interpBlocks(field.nb, field.w, field.h, field.vy, x, y) };
}

// ---------------------------------------------------------------------------
// Crecimiento o debilitamiento: cambio de dBZ siguiendo a la lluvia (cada
// píxel de ahora contra el punto de donde venía), promediado por zonas.

const TREND_MAX = 2;   // dBZ por 10 min
const TREND_TAU = 30;  // min: la tendencia no se extrapola sin límite

function intensityTrend(gridOld, gridNew, box, dtMin, motion, field, { nb = 3 } = {}) {
  if (!gridOld || !gridNew || !motion || !(dtMin > 0)) return null;
  const { w, h } = gridNew;
  const sum = new Float64Array(nb * nb), cnt = new Float64Array(nb * nb);
  const FLOOR = 5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const vn = gridNew.dbz[i];
      const v = velocityAt(field, motion, x, y);
      const ox = Math.round(x - v.vx * dtMin), oy = Math.round(y - v.vy * dtMin);
      if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
      const j = oy * w + ox;
      if (gridNew.kind[i] === 255 || gridOld.kind[j] === 255) continue;
      const vo = gridOld.dbz[j];
      if (!(vn >= 10) && !(vo >= 10)) continue;
      const d = clamp((vn >= 10 ? vn : FLOOR) - (vo >= 10 ? vo : FLOOR), -15, 15);
      const k = Math.min(nb - 1, Math.floor((y / h) * nb)) * nb + Math.min(nb - 1, Math.floor((x / w) * nb));
      sum[k] += d; cnt[k]++;
    }
  }
  const d = new Float32Array(nb * nb);
  const minCount = minPixelsFor(box, 60);
  for (let k = 0; k < nb * nb; k++) d[k] = cnt[k] >= minCount ? clamp((sum[k] / cnt[k] / dtMin) * 10, -TREND_MAX, TREND_MAX) : 0;
  return { nb, w, h, d };
}

/** dBZ que hay que sumar a t minutos con una tendencia (dBZ/10 min) dada. */
function trendDelta(per10, t) {
  return clamp(per10, -TREND_MAX, TREND_MAX) * (TREND_TAU / 10) * (1 - Math.exp(-t / TREND_TAU));
}

// ---------------------------------------------------------------------------
// Previsión por conjunto: en vez de un único vector se prueban 25 variantes
// (velocidad ±, dirección ±, y un pequeño desvío absoluto), con un peso
// gaussiano. La probabilidad de lluvia en cada paso es el peso de las que
// traen lluvia. La dispersión depende de cuánto discrepan los fotogramas.

const ENSEMBLE_STEPS = [-1.5, -0.75, 0, 0.75, 1.5];

function ensembleMembers(motion, box) {
  const speed = Math.hypot(motion.vx, motion.vy);
  const conf = motion.confidence === undefined ? 0.6 : motion.confidence;
  const rel = speed > 1e-6 ? (motion.spreadPx || 0) / speed : 1;
  const sS = clamp(0.1 + 0.5 * rel + 0.2 * (1 - conf), 0.1, 0.45);
  const sA = clamp(8 + 35 * rel + 15 * (1 - conf), 8, 40) * DEG;
  const sJ = ((2 + 4 * (1 - conf)) * 1000) / 60 / box.mpp; // km/h → px/min
  const out = [];
  for (const a of ENSEMBLE_STEPS) {
    for (const s of ENSEMBLE_STEPS) {
      out.push({ scale: 1 + s * sS, rot: a * sA, jx: s * sJ, jy: a * sJ, w: Math.exp(-(a * a + s * s) / 2), central: a === 0 && s === 0 });
    }
  }
  return out;
}

function perturb(v, m) {
  const c = Math.cos(m.rot), s = Math.sin(m.rot);
  return { vx: (v.vx * c - v.vy * s) * m.scale + m.jx, vy: (v.vx * s + v.vy * c) * m.scale + m.jy };
}

/**
 * Extrapola el último fotograma hacia atrás por trayectorias: la lluvia que
 * habrá en la ubicación dentro de t minutos es la que ahora está en el punto
 * de donde viene el aire (siguiendo el campo de movimiento por zonas).
 * Devuelve por paso: probabilidad p, intensidad esperada y si se conoce.
 */
function nowcast(grid, box, motion, { thresholdDbz, horizonMin = 120, stepMin = 5, probeKm = 2, field = null, trend = null, at = null }) {
  // `at`: punto de la caja (px) donde se calcula; por defecto, la ubicación.
  const x0 = at ? at.x : box.cx, y0 = at ? at.y : box.cy;
  const rProbe = Math.max(1, (probeKm * 1000) / box.mpp);
  const margin = rProbe + 1;
  const series = [];
  const now = probe(grid, x0, y0, rProbe);
  const wetNow = now.dbz >= thresholdDbz;
  const mem = motion ? ensembleMembers(motion, box) : null;
  const pos = mem ? mem.map(() => ({ x: x0, y: y0, out: false })) : null;
  let etaMin = null, etaEarly = null, etaLate = null, endMin = null, dryRun = 0;
  const unknown = (t) => ({ t, p: null, dbz: null, kind: 0, known: false, rate: 0 });

  for (let t = 0; t <= horizonMin; t += stepMin) {
    if (t === 0) {
      const dbz = isFinite(now.dbz) ? now.dbz : null;
      series.push(now.inside
        ? { t, p: wetNow ? 1 : 0, dbz, kind: now.kind, known: true, rate: dbz === null ? 0 : P.dbzToRate(dbz, now.kind) }
        : unknown(t));
      continue;
    }
    if (!mem) { series.push(unknown(t)); continue; }
    let sw = 0, swKnown = 0, swWet = 0, rateSum = 0, snowW = 0, central = null;
    for (let k = 0; k < mem.length; k++) {
      const m = mem[k], p = pos[k];
      sw += m.w;
      if (!p.out) {
        const v = perturb(velocityAt(field, motion, p.x, p.y), m);
        p.x -= v.vx * stepMin;
        p.y -= v.vy * stepMin;
        if (p.x < margin || p.y < margin || p.x > grid.w - margin || p.y > grid.h - margin) p.out = true;
      }
      if (p.out) continue;
      const q = probe(grid, p.x, p.y, rProbe);
      if (!q.inside) continue;
      let dbz = isFinite(q.dbz) ? q.dbz : null;
      if (dbz !== null && trend) dbz += trendDelta(interpBlocks(trend.nb, trend.w, trend.h, trend.d, p.x, p.y), t);
      const kind = q.kind || P.KIND_RAIN;
      swKnown += m.w;
      if (dbz !== null && dbz >= thresholdDbz) { swWet += m.w; if (kind === P.KIND_SNOW) snowW += m.w; }
      rateSum += m.w * (dbz === null || dbz < 10 ? 0 : P.dbzToRate(dbz, kind));
      if (m.central) central = { kind };
    }
    if (swKnown < 0.5 * sw) { series.push(unknown(t)); continue; }
    const p = swWet / swKnown;
    const rate = rateSum / swKnown;
    const kind = central ? central.kind : snowW > swWet / 2 ? P.KIND_SNOW : P.KIND_RAIN;
    series.push({ t, p, dbz: rate > 0 ? P.rateToDbz(rate, kind) : null, kind, known: true, rate });
    if (!wetNow) {
      if (etaEarly === null && p >= 0.2) etaEarly = t;
      if (etaMin === null && p >= 0.5) etaMin = t;
      if (etaLate === null && p >= 0.8) etaLate = t;
    } else if (endMin === null) {
      if (p < 0.5) { dryRun++; if (dryRun >= 2) endMin = t - stepMin; } else dryRun = 0;
    }
  }
  return {
    series, etaMin: wetNow ? 0 : etaMin, etaEarly: wetNow ? null : etaEarly, etaLate: wetNow ? null : etaLate,
    endMin, stepMin, horizonMin, members: mem ? mem.length : 0
  };
}

module.exports = {
  TILE_SIZE, ZOOM, WORLD, MIN_ECHO_KM2,
  project, unproject, metersPerPixel, boxFor,
  minPixelsFor, components, cleanGrid, staticEchoes,
  locationStats, estimateMotion, combineMotion, estimateMotionField, combineFields, velocityAt,
  intensityTrend, trendDelta, ensembleMembers, nowcast, bearingDeg, probe
};
