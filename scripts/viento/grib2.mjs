// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Lector GRIB2 mínimo para los recortes del filtro de NOMADS (NOAA): rejilla
 * latitud-longitud regular (plantilla 3.0), producto en un instante
 * (plantilla 4.0) y empaquetado simple (plantilla 5.0), sin mapa de bits.
 * Es justo lo que devuelve filter_gfs_0p25.pl; cualquier otra cosa da error
 * en lugar de valores equivocados.
 */

// GRIB2 guarda los enteros con signo como signo + magnitud, no en complemento a dos.
const sm16 = (dv, o) => { const v = dv.getUint16(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const sm32 = (dv, o) => { const v = dv.getUint32(o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
const sm8 = (b) => (b & 0x80 ? -(b & 0x7f) : b);

function unpack(bytes, start, end, n, nbits, R, E, D) {
  const out = new Float32Array(n);
  const k2 = 2 ** E, k10 = 10 ** -D;
  if (nbits === 0) { out.fill(R * k10); return out; }
  if ((end - start) * 8 < n * nbits) throw new Error('GRIB2: faltan datos en la sección 7');
  // Valores de nbits bits seguidos, el bit más significativo primero.
  let bit = start * 8;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let k = 0; k < nbits; k++, bit++) x = x * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    out[i] = (R + x * k2) * k10;
  }
  return out;
}

/** Devuelve los mensajes del fichero: { refTime, hour, cat, num, surface, level, grid, values }. */
export function parseGrib2(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const msgs = [];
  let p = 0;
  while (p + 16 <= bytes.length) {
    if (String.fromCharCode(...bytes.subarray(p, p + 4)) !== 'GRIB') throw new Error(`GRIB2: no empieza por GRIB en ${p}`);
    if (bytes[p + 7] !== 2) throw new Error(`GRIB2: edición ${bytes[p + 7]}`);
    const total = Number(dv.getBigUint64(p + 8));
    if (p + total > bytes.length) throw new Error('GRIB2: mensaje cortado');
    const m = {};
    let o = p + 16, pack = null;
    while (o < p + total - 4) {
      const len = dv.getUint32(o), sec = bytes[o + 4];
      if (sec === 1) {
        m.refTime = Date.UTC(dv.getUint16(o + 12), bytes[o + 14] - 1, bytes[o + 15], bytes[o + 16], bytes[o + 17], bytes[o + 18]);
      } else if (sec === 3) {
        if (dv.getUint16(o + 12) !== 0) throw new Error(`GRIB2: rejilla ${dv.getUint16(o + 12)} (solo latitud-longitud)`);
        if (dv.getUint32(o + 38) !== 0 && dv.getUint32(o + 38) !== 0xffffffff) throw new Error('GRIB2: ángulo base distinto de 0');
        m.grid = {
          ni: dv.getUint32(o + 30), nj: dv.getUint32(o + 34),
          la1: sm32(dv, o + 46) / 1e6, lo1: sm32(dv, o + 50) / 1e6,
          la2: sm32(dv, o + 55) / 1e6, lo2: sm32(dv, o + 59) / 1e6,
          di: dv.getUint32(o + 63) / 1e6, dj: dv.getUint32(o + 67) / 1e6,
          scan: bytes[o + 71]
        };
      } else if (sec === 4) {
        if (dv.getUint16(o + 7) !== 0) throw new Error(`GRIB2: producto ${dv.getUint16(o + 7)} (solo instantáneo)`);
        if (bytes[o + 17] !== 1) throw new Error(`GRIB2: unidad de tiempo ${bytes[o + 17]} (solo horas)`);
        m.cat = bytes[o + 9];
        m.num = bytes[o + 10];
        m.hour = dv.getUint32(o + 18);
        m.surface = bytes[o + 22];
        m.level = dv.getUint32(o + 24) / 10 ** sm8(bytes[o + 23]);
      } else if (sec === 5) {
        if (dv.getUint16(o + 9) !== 0) throw new Error(`GRIB2: empaquetado ${dv.getUint16(o + 9)} (solo simple)`);
        pack = { n: dv.getUint32(o + 5), R: dv.getFloat32(o + 11), E: sm16(dv, o + 15), D: sm16(dv, o + 17), nbits: bytes[o + 19] };
      } else if (sec === 6) {
        if (bytes[o + 5] !== 255) throw new Error('GRIB2: con mapa de bits');
      } else if (sec === 7) {
        if (!pack) throw new Error('GRIB2: datos sin sección 5');
        m.values = unpack(bytes, o + 5, o + len, pack.n, pack.nbits, pack.R, pack.E, pack.D);
      }
      o += len;
    }
    if (!m.grid || !m.values || m.values.length !== m.grid.ni * m.grid.nj) throw new Error('GRIB2: mensaje incompleto');
    msgs.push(m);
    p += total;
  }
  return msgs;
}

/**
 * Pasa un campo a la rejilla del destino (de norte a sur y de oeste a este),
 * que debe coincidir punto por punto con la del fichero.
 */
export function toNorthUp(msg, grid) {
  const g = msg.grid;
  const lon = (x) => ((x + 540) % 360) - 180;
  const south = Math.min(g.la1, g.la2), north = Math.max(g.la1, g.la2);
  const ok = g.ni === grid.cols && g.nj === grid.rows && Math.abs(g.di - grid.step) < 1e-6 && Math.abs(g.dj - grid.step) < 1e-6 &&
    Math.abs(north - grid.north) < 1e-6 && Math.abs(south - (grid.north - (grid.rows - 1) * grid.step)) < 1e-6 &&
    Math.abs(lon(g.lo1) - grid.west) < 1e-6;
  if (!ok) throw new Error(`GRIB2: la rejilla no es la esperada (${JSON.stringify(g)})`);
  if (g.scan & 0x80 || g.scan & 0x20) throw new Error(`GRIB2: orden de barrido ${g.scan} no admitido`);
  const southFirst = (g.scan & 0x40) !== 0;
  const out = new Float32Array(grid.rows * grid.cols);
  for (let r = 0; r < grid.rows; r++) {
    const src = southFirst ? grid.rows - 1 - r : r;
    out.set(msg.values.subarray(src * grid.cols, (src + 1) * grid.cols), r * grid.cols);
  }
  return out;
}
