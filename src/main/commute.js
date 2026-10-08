// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
/*
 * Trayectos habituales (p. ej. casa → trabajo a las 8:15 de lunes a viernes).
 * Antes de salir se calcula la probabilidad de lluvia en varios puntos del
 * recorrido, cada uno a la hora a la que se pasará por él, con la misma
 * previsión combinada (radar + modelo) que el resto de la app. Si salir un
 * poco antes o después mejora mucho, se sugiere.
 */
const F = require('../shared/forecast');
const D = require('../shared/describe');
const P = require('../shared/palette');

const MIN = 60000;
const SAMPLES = 6;
const OFFSETS = [-30, -20, -10, 0, 10, 20, 30];

function routePoints(from, to, n = SAMPLES) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    out.push({ f, lat: from.lat + (to.lat - from.lat) * f, lon: from.lon + (to.lon - from.lon) * f });
  }
  return out;
}

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Hora de salida de hoy (ms) o null si hoy no toca. */
function departureToday(c, now) {
  const d = new Date(now);
  if (!c.days || !c.days.includes(d.getDay())) return null;
  const [h, m] = String(c.time || '08:00').split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

/** ¿Toca comprobar ahora? Devuelve la clave del día/hora o null. */
function dueKey(c, now) {
  if (!c.enabled) return null;
  const dep = departureToday(c, now);
  if (dep === null) return null;
  const start = dep - (c.leadMin || 30) * MIN;
  if (now < start || now >= start + 15 * MIN) return null;
  const key = `${new Date(dep).toDateString()} ${c.time}`;
  return c.lastKey === key ? null : key;
}

/**
 * Probabilidad de lluvia en el recorrido saliendo a `depTs`.
 * `radar`: resultado de analyze con `points` (los de routePoints); `model`:
 * previsión del modelo en el punto medio. Devuelve { pMax, where, rateMax }.
 */
function routeRisk({ radar, model, alarm, points, depTs, durationMin, now }) {
  let pMax = 0, rateMax = 0, where = null, known = 0;
  points.forEach((pt, i) => {
    const rp = radar && radar.ok && radar.points ? radar.points[i] : null;
    const status = {
      radar: rp ? { ok: true, frameTime: radar.frameTime, motion: radar.motion, nowcast: rp.nowcast, atLocation: null } : null,
      model
    };
    const ol = F.blend(status, { alarm }, { now, horizonMin: 240 });
    if (!ol) return;
    const ts = depTs + pt.f * durationMin * MIN;
    const s = ol.series[Math.round((ts - now) / (ol.stepMin * MIN))];
    if (!s || !s.known) return;
    known++;
    if (s.p > pMax) { pMax = s.p; where = pt.f < 0.34 ? 'start' : pt.f > 0.66 ? 'end' : 'middle'; }
    rateMax = Math.max(rateMax, s.rate || 0);
  });
  return known ? { pMax, where, rateMax } : null;
}

/** Riesgo saliendo a la hora prevista y la mejor alternativa cercana. */
function evaluateCommute({ radar, model, alarm, points, depTs, durationMin, now }) {
  const risk = (off) => routeRisk({ radar, model, alarm, points, depTs: depTs + off * MIN, durationMin, now });
  const base = risk(0);
  if (!base) return null;
  let best = null;
  for (const off of OFFSETS) {
    if (!off || depTs + off * MIN < now) continue;
    const r = risk(off);
    if (r && (!best || r.pMax < best.pMax - 1e-9 || (Math.abs(r.pMax - best.pMax) < 1e-9 && Math.abs(off) < Math.abs(best.offsetMin)))) best = { offsetMin: off, ...r };
  }
  // Solo se sugiere si mejora de verdad (al menos 25 puntos y queda por debajo del 40 %).
  const suggest = best && base.pMax - best.pMax >= 0.25 && best.pMax < 0.4 ? best : null;
  return { ...base, suggest };
}

function commuteText(t, res, { fromName, toName, time, depTs, units }) {
  const route = `${fromName} → ${toName}`;
  const p = Math.round(res.pMax * 100);
  const whereTxt = res.where ? t(`commute.where.${res.where}`) : '';
  let title, body;
  if (res.pMax >= 0.5) {
    title = t('commute.rain.title', { route, time });
    body = t('commute.rain.body', { p, where: whereTxt, level: D.levelName(t, P.rateToDbz(Math.max(0.1, res.rateMax), P.KIND_RAIN)), rate: D.fmtRate(t, res.rateMax, units) });
  } else if (res.pMax >= 0.25) {
    title = t('commute.maybe.title', { route, time });
    body = t('commute.maybe.body', { p, where: whereTxt });
  } else {
    title = t('commute.dry.title', { route, time });
    body = t('commute.dry.body', { p });
  }
  if (res.suggest) {
    const alt = D.fmtClock(t, depTs + res.suggest.offsetMin * MIN);
    body += ' ' + t('commute.suggest', { time: alt, p: Math.round(res.suggest.pMax * 100) });
  }
  return { title, body, rain: res.pMax >= 0.5, maybe: res.pMax >= 0.25 };
}

module.exports = { routePoints, distanceKm, departureToday, dueKey, routeRisk, evaluateCommute, commuteText, SAMPLES };
