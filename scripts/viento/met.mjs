// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Lluvia y temperatura a 2 m de cada hora de un modelo, para el modo
 * «Previsión» (formato en src/shared/metgrid.js). La temperatura es un campo
 * normal; la lluvia, en cambio, los modelos la dan ACUMULADA, y cada uno a su
 * manera (GRIB2, plantilla 4.8: la «hora de previsión» es el principio del
 * intervalo y su duración sale de la sección del intervalo):
 *
 *  - ECMWF (parámetro 1/193, en metros): desde el principio de la pasada, en
 *    todas las horas.
 *  - ICON-EU (1/52, en kg/m² = mm): desde el principio de la pasada.
 *  - GFS (1/8, en kg/m² = mm): lleva dos mensajes por hora, el acumulado desde
 *    el principio de la pasada (intervalo 0–h) y el del tramo de 6 horas en
 *    curso (6–h, 12–h…), que vuelve a cero cada 6 horas. Se usa el primero; si
 *    faltara, el segundo se suma al acumulado de la hora en que empezó el tramo.
 *
 * `ratesFromAccumulated` convierte eso en la media (mm/h) del tramo que acaba
 * en cada hora publicada.
 */
import { extract } from './grib2.mjs';

/** Parámetro GRIB2 [categoría, número] de la lluvia de cada modelo y su factor a mm. */
export const PREC = {
  ecmwf: { cat: 1, num: 193, mm: 1000 },
  'icon-eu': { cat: 1, num: 52, mm: 1 },
  gfs: { cat: 1, num: 8, mm: 1 }
};

/**
 * De los mensajes de una hora: la temperatura a 2 m (°C) y los mensajes de
 * lluvia acumulada ([{ start, values }] en mm; `start` es la hora de previsión
 * en que empieza cada acumulado). Con h = 0 no hay lluvia (acc = null).
 * `valid(m)` comprueba que el mensaje es de la pasada y la hora pedidas.
 */
export function pickMet(msgs, model, grid, h, valid) {
  const t = msgs.find((x) => x.discipline === 0 && x.cat === 0 && x.num === 0 && x.surface === 103 && x.level === 2);
  if (!t) throw new Error(`falta la temperatura a +${h} h`);
  valid(t);
  const temp = extract(t, grid).map((k) => k - 273.15);
  if (!h) return { temp, acc: null };
  const p = PREC[model];
  const acc = [];
  for (const m of msgs) {
    if (m.discipline !== 0 || m.cat !== p.cat || m.num !== p.num || m.surface !== 1) continue;
    if (m.stat !== 1) throw new Error(`la lluvia de +${h} h no es una acumulación (proceso ${m.stat})`);
    valid(m);
    if (acc.some((a) => a.start === m.start)) continue; // GFS repite el mensaje cuando el tramo de 6 h es el acumulado entero
    acc.push({ start: m.start, values: extract(m, grid).map((v) => v * p.mm) });
  }
  if (!acc.length) throw new Error(`falta la lluvia a +${h} h`);
  return { temp, acc };
}

/**
 * Lluvia media (mm/h) del tramo que acaba en cada hora, a partir de los
 * acumulados. `steps`: [{ h, acc }] en orden de hora, con `acc` de pickMet
 * (null en +0 h, donde no ha llovido nada) y `n` los puntos de la rejilla.
 * Devuelve [{ h, rate, span }] de las horas cuyo acumulado se pudo reconstruir
 * (las demás no salen), con `span` las horas desde la anterior de esa lista:
 * si falta una hora, el tramo se alarga y su lluvia media se reparte por
 * igual. +0 h sale con span 0 y sin lluvia.
 */
export function ratesFromAccumulated(steps, n) {
  const out = [];
  const total = new Map(); // hora → acumulado desde el principio de la pasada
  let prev = { h: 0, a: new Float32Array(n) }; // al principio de la pasada no hay nada acumulado
  for (const s of steps) {
    if (s.h === 0) { out.push({ h: 0, rate: new Float32Array(n), span: 0 }); continue; }
    let a = null;
    if (s.acc) {
      const whole = s.acc.find((c) => c.start === 0);
      if (whole) a = whole.values;
      else {
        // El tramo de 6 h de GFS: se suma al acumulado de la hora en que empezó.
        const part = s.acc.find((c) => total.has(c.start));
        if (part) { const base = total.get(part.start); a = part.values.map((v, i) => v + base[i]); }
      }
    }
    if (!a) continue;
    total.set(s.h, a);
    const span = s.h - prev.h;
    const rate = new Float32Array(n);
    // El redondeo de los dos acumulados puede dar un poco por debajo de cero.
    for (let i = 0; i < n; i++) rate[i] = Math.max(0, (a[i] - prev.a[i]) / span);
    out.push({ h: s.h, rate, span });
    prev = { h: s.h, a };
  }
  return out;
}
