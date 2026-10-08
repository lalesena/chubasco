// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Lector GRIB2 mínimo para los modelos del modo «Viento»: rejilla
 * latitud-longitud regular (plantilla 3.0), producto en un instante o en un
 * intervalo (plantillas 4.0 y 4.8, la racha máxima) y dos empaquetados: el
 * simple (5.0, el de los recortes del filtro de NOMADS para GFS) y el CCSDS
 * (5.42, el de ECMWF y el DWD), sin mapa de bits. Cualquier otra cosa da
 * error en lugar de valores equivocados.
 */

// GRIB2 guarda los enteros con signo como signo + magnitud, no en complemento a dos.
const sm16 = (dv, o) => { const v = dv.getUint16(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const sm32 = (dv, o) => { const v = dv.getUint32(o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };
const sm8 = (b) => (b & 0x80 ? -(b & 0x7f) : b);

// ---------------------------------------------------------------------------
// Lectura de bits, el más significativo primero

class Bits {
  constructor(bytes, start, end) { this.b = bytes; this.p = start * 8; this.end = end * 8; }
  read(n) {
    if (this.p + n > this.end) throw new Error('GRIB2: datos cortados');
    let v = 0;
    while (n > 0) {
      const used = this.p & 7, avail = 8 - used, take = avail < n ? avail : n;
      v = v * (1 << take) + ((this.b[this.p >> 3] >> (avail - take)) & ((1 << take) - 1));
      this.p += take;
      n -= take;
    }
    return v;
  }
  /** Secuencia fundamental: cuántos ceros hay antes del siguiente 1. */
  fs() {
    let count = 0;
    for (;;) {
      if (this.p >= this.end) throw new Error('GRIB2: datos cortados');
      const used = this.p & 7;
      const rest = (this.b[this.p >> 3] << used) & 0xff;
      if (rest === 0) { count += 8 - used; this.p += 8 - used; continue; }
      const zeros = Math.clz32(rest) - 24;
      this.p += zeros + 1;
      return count + zeros;
    }
  }
  align() { this.p = (this.p + 7) & ~7; }
}

// ---------------------------------------------------------------------------
// Empaquetado simple: nbits bits por valor

function unpackSimple(bytes, start, end, n, nbits) {
  const out = new Float64Array(n);
  if (nbits === 0) return out;
  if ((end - start) * 8 < n * nbits) throw new Error('GRIB2: faltan datos en la sección 7');
  const bits = new Bits(bytes, start, end);
  for (let i = 0; i < n; i++) out[i] = bits.read(nbits);
  return out;
}

// ---------------------------------------------------------------------------
// CCSDS 121.0-B (compresión Rice adaptativa, la de libaec): bloques de
// `block` muestras agrupados en intervalos de referencia de `rsi` bloques.
// Cada bloque empieza con un identificador de opción: bloques de ceros,
// «segunda extensión» (pares de valores pequeños en un solo código),
// división de muestras (k bits bajos aparte) o sin comprimir. Con
// preprocesado, cada intervalo empieza con una muestra de referencia y el
// resto son diferencias con la anterior, plegadas a enteros sin signo.

const AEC_SIGNED = 1, AEC_PREPROCESS = 8, AEC_RESTRICTED = 16, AEC_PAD_RSI = 32;
const ROS = 5; // código de «hasta el final del segmento» en los bloques de ceros
// Segunda extensión: código m → par (i − d, d), con m = i(i + 1)/2 + d.
const SE_I = [], SE_START = [];
for (let i = 0; i < 13; i++) for (let j = 0; j <= i; j++) { SE_I.push(i); SE_START.push((i * (i + 1)) / 2); }

export function aecDecode(bytes, start, end, n, bps, block, rsi, flags) {
  if (flags & AEC_SIGNED) throw new Error('GRIB2: CCSDS con signo no admitido');
  if (!(bps > 0 && bps <= 32) || !(block > 0) || !(rsi > 0)) throw new Error('GRIB2: parámetros CCSDS no válidos');
  const idLen = bps > 16 ? 5 : bps > 8 ? 4 : (flags & AEC_RESTRICTED) && bps <= 4 ? (bps <= 2 ? 1 : 2) : 3;
  const idUncomp = (1 << idLen) - 1;
  const pp = !!(flags & AEC_PREPROCESS);
  const xmax = 2 ** bps - 1, half = Math.floor(xmax / 2);
  const bits = new Bits(bytes, start, end);
  const out = new Float64Array(n);
  const buf = new Float64Array(rsi * block + block);
  let o = 0;
  while (o < n) {
    // Un intervalo de referencia.
    let k = 0, blocks = 0;
    while (blocks < rsi && o + k < n) {
      const ref = pp && k === 0 ? 1 : 0;
      const id = bits.read(idLen);
      if (id === 0) {
        const se = bits.read(1);
        if (ref) buf[k++] = bits.read(bps);
        if (se) {
          for (let i = ref; i < block;) {
            const m = bits.fs();
            if (m >= SE_I.length) throw new Error('GRIB2: código CCSDS no válido');
            const d1 = m - SE_START[m];
            if ((i & 1) === 0) { buf[k++] = SE_I[m] - d1; i++; }
            buf[k++] = d1;
            i++;
          }
          blocks++;
        } else {
          let zero = bits.fs() + 1;
          if (zero === ROS) { const b = Math.floor(k / block); zero = Math.min(rsi - b, 64 - (b % 64)); } else if (zero > ROS) zero--;
          if (k + zero * block - ref > buf.length) throw new Error('GRIB2: bloque de ceros CCSDS demasiado largo');
          for (let i = zero * block - ref; i > 0; i--) buf[k++] = 0;
          blocks += zero;
        }
      } else if (id === idUncomp) {
        for (let i = 0; i < block; i++) buf[k++] = bits.read(bps);
        blocks++;
      } else {
        const low = id - 1;
        if (ref) buf[k++] = bits.read(bps);
        const first = k, mul = 2 ** low;
        for (let i = ref; i < block; i++) buf[k++] = bits.fs();
        if (low) for (let i = first; i < k; i++) buf[i] = buf[i] * mul + bits.read(low);
        blocks++;
      }
    }
    // Deshace el preprocesado (predicción por la muestra anterior).
    const cnt = Math.min(k, n - o);
    if (pp) {
      let x = buf[0];
      out[o] = x;
      for (let i = 1; i < cnt; i++) {
        const d = buf[i], h = (d - (d % 2)) / 2 + (d % 2);
        if (x > half) x = h <= xmax - x ? (d % 2 ? x - h : x + h) : xmax - d;
        else x = h <= x ? (d % 2 ? x - h : x + h) : d;
        out[o + i] = x;
      }
    } else {
      for (let i = 0; i < cnt; i++) out[o + i] = buf[i];
    }
    o += cnt;
    if (flags & AEC_PAD_RSI) bits.align();
  }
  return out;
}

// ---------------------------------------------------------------------------

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
        // 4.0: en un instante; 4.8: en un intervalo (la racha máxima de la última hora o las últimas horas).
        const tmpl = dv.getUint16(o + 7);
        if (tmpl !== 0 && tmpl !== 8) throw new Error(`GRIB2: producto ${tmpl} no admitido`);
        // Horas (NOAA, ECMWF) o minutos (DWD).
        const hours = (unit, v) => {
          if (unit === 1) return v;
          if (unit === 0) return v / 60;
          throw new Error(`GRIB2: unidad de tiempo ${unit} (solo horas o minutos)`);
        };
        m.cat = bytes[o + 9];
        m.num = bytes[o + 10];
        m.hour = hours(bytes[o + 17], dv.getUint32(o + 18));
        m.surface = bytes[o + 22];
        m.level = dv.getUint32(o + 24) / 10 ** sm8(bytes[o + 23]);
        if (tmpl === 8) {
          // El intervalo (p. ej. la racha máxima de la última hora): la hora válida es su final.
          if (bytes[o + 41] < 1) throw new Error('GRIB2: intervalo no admitido');
          m.span = hours(bytes[o + 48], dv.getUint32(o + 49));
          m.hour += m.span;
        }
      } else if (sec === 5) {
        const tmpl = dv.getUint16(o + 9);
        if (tmpl !== 0 && tmpl !== 42) throw new Error(`GRIB2: empaquetado ${tmpl} (solo simple o CCSDS)`);
        pack = { tmpl, n: dv.getUint32(o + 5), R: dv.getFloat32(o + 11), E: sm16(dv, o + 15), D: sm16(dv, o + 17), nbits: bytes[o + 19] };
        if (tmpl === 42) Object.assign(pack, { flags: bytes[o + 21], block: bytes[o + 22], rsi: dv.getUint16(o + 23) });
      } else if (sec === 6) {
        if (bytes[o + 5] !== 255) throw new Error('GRIB2: con mapa de bits');
      } else if (sec === 7) {
        if (!pack) throw new Error('GRIB2: datos sin sección 5');
        const x = pack.tmpl === 42 && pack.nbits
          ? aecDecode(bytes, o + 5, o + len, pack.n, pack.nbits, pack.block, pack.rsi, pack.flags)
          : unpackSimple(bytes, o + 5, o + len, pack.n, pack.nbits);
        // Y = (R + X · 2^E) / 10^D
        const k2 = 2 ** pack.E, k10 = 10 ** -pack.D;
        m.values = new Float32Array(pack.n);
        for (let i = 0; i < pack.n; i++) m.values[i] = (pack.R + x[i] * k2) * k10;
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
 * Recorta un campo a la rejilla del destino (de norte a sur y de oeste a
 * este, con la misma resolución): cada punto del destino tiene que coincidir
 * con uno del fichero. Vale para un recorte exacto (NOMADS), una zona de una
 * rejilla mayor (ICON-EU) o de la rejilla global (ECMWF, que da la vuelta al
 * meridiano 180).
 */
export function extract(msg, grid) {
  const g = msg.grid;
  if (g.scan & 0x80 || g.scan & 0x20) throw new Error(`GRIB2: orden de barrido ${g.scan} no admitido`);
  if (Math.abs(g.di - grid.step) > 1e-6 || Math.abs(g.dj - grid.step) > 1e-6) throw new Error(`GRIB2: la resolución no es la esperada (${g.di}°)`);
  const southFirst = (g.scan & 0x40) !== 0;
  const cols = new Int32Array(grid.cols);
  for (let c = 0; c < grid.cols; c++) {
    const x = (((grid.west + c * grid.step - g.lo1) % 360) + 360) % 360 / g.di;
    const i = Math.round(x);
    if (Math.abs(x - i) > 1e-4 || i >= g.ni) throw new Error(`GRIB2: la rejilla no cubre la longitud ${grid.west + c * grid.step}`);
    cols[c] = i;
  }
  const out = new Float32Array(grid.rows * grid.cols);
  for (let r = 0; r < grid.rows; r++) {
    const lat = grid.north - r * grid.step;
    const y = southFirst ? (lat - g.la1) / g.dj : (g.la1 - lat) / g.dj;
    const j = Math.round(y);
    if (Math.abs(y - j) > 1e-4 || j < 0 || j >= g.nj) throw new Error(`GRIB2: la rejilla no cubre la latitud ${lat}`);
    const row = j * g.ni;
    for (let c = 0; c < grid.cols; c++) out[r * grid.cols + c] = msg.values[row + cols[c]];
  }
  return out;
}
