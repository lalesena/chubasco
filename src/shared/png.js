/*
 * Decodificador PNG mínimo sobre DecompressionStream, que existe igual en el
 * navegador y en Node: la app de escritorio y la versión web leen las
 * imágenes de los rayos exactamente igual (y la web no necesita
 * cargar una librería de PNG). Admite escala de grises, RGB y paleta, con o
 * sin alfa, a 1–16 bits; no admite PNG entrelazados (EUMETSAT
 * no los usa). UMD: self.RA_PNG en el navegador.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RA_PNG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  async function inflate(parts) {
    const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  }

  /** Deshace los filtros de cada línea. */
  function unfilter(raw, height, stride, bpp) {
    const out = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
      const src = y * (stride + 1);
      const filter = raw[src];
      const cur = y * stride;
      const prev = cur - stride;
      for (let i = 0; i < stride; i++) {
        const x = raw[src + 1 + i];
        const a = i >= bpp ? out[cur + i - bpp] : 0;
        const b = y ? out[prev + i] : 0;
        const c = y && i >= bpp ? out[prev + i - bpp] : 0;
        let v;
        switch (filter) {
          case 0: v = x; break;
          case 1: v = x + a; break;
          case 2: v = x + b; break;
          case 3: v = x + ((a + b) >> 1); break;
          case 4: v = x + paeth(a, b, c); break;
          default: throw new Error(`PNG: filtro desconocido ${filter}`);
        }
        out[cur + i] = v & 255;
      }
    }
    return out;
  }

  /**
   * ArrayBuffer | Uint8Array con un PNG → { width, height, data } con los
   * píxeles en RGBA de 8 bits, sin premultiplicar.
   */
  async function decode(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) throw new Error('PNG no válido');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let width = 0, height = 0, depth = 0, type = -1, interlace = 0, palette = null, trns = null;
    const idat = [];
    for (let pos = 8; pos + 8 <= b.length;) {
      const len = dv.getUint32(pos);
      const name = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      const data = b.subarray(pos + 8, pos + 8 + len);
      if (name === 'IHDR') {
        width = dv.getUint32(pos + 8);
        height = dv.getUint32(pos + 12);
        depth = b[pos + 16];
        type = b[pos + 17];
        interlace = b[pos + 20];
      } else if (name === 'PLTE') palette = data;
      else if (name === 'tRNS') trns = data;
      else if (name === 'IDAT') idat.push(data);
      else if (name === 'IEND') break;
      pos += 12 + len;
    }
    const channels = CHANNELS[type];
    if (!width || !height || !channels) throw new Error('PNG sin cabecera válida');
    if (interlace) throw new Error('PNG entrelazado no admitido');
    if (type === 3 && !palette) throw new Error('PNG de paleta sin paleta');

    const bitsPerPixel = channels * depth;
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const raw = await inflate(idat);
    if (raw.length < height * (stride + 1)) throw new Error('PNG incompleto');
    const px = unfilter(raw, height, stride, bpp);

    // Muestra k de la línea y (0–255 para 8/16 bits; el valor tal cual para <8).
    const sample = depth === 8
      ? (row, k) => px[row + k]
      : depth === 16
        ? (row, k) => px[row + 2 * k]
        : (row, k) => {
          const bit = k * depth;
          return (px[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        };
    // Valor exacto (16 bits) para comparar con el color transparente de tRNS.
    const full = depth === 16 ? (row, k) => (px[row + 2 * k] << 8) | px[row + 2 * k + 1] : sample;
    const scale = type === 3 || depth >= 8 ? 1 : 255 / ((1 << depth) - 1);
    const trnsKey = trns && (type === 0 || type === 2)
      ? Array.from({ length: type === 0 ? 1 : 3 }, (_, i) => (trns[2 * i] << 8) | trns[2 * i + 1])
      : null;

    const out = new Uint8Array(width * height * 4);
    if (type === 6 && depth === 8) {
      for (let y = 0; y < height; y++) out.set(px.subarray(y * stride, y * stride + width * 4), y * width * 4);
      return { width, height, data: out };
    }
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const k = x * channels;
        if (type === 3) {
          const idx = sample(row, k);
          out[o] = palette[idx * 3] || 0;
          out[o + 1] = palette[idx * 3 + 1] || 0;
          out[o + 2] = palette[idx * 3 + 2] || 0;
          out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        } else if (type === 0 || type === 4) {
          const g = Math.round(sample(row, k) * scale);
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = type === 4 ? sample(row, k + 1) : trnsKey && full(row, k) === trnsKey[0] ? 0 : 255;
        } else {
          out[o] = sample(row, k);
          out[o + 1] = sample(row, k + 1);
          out[o + 2] = sample(row, k + 2);
          out[o + 3] = type === 6
            ? sample(row, k + 3)
            : trnsKey && full(row, k) === trnsKey[0] && full(row, k + 1) === trnsKey[1] && full(row, k + 2) === trnsKey[2] ? 0 : 255;
        }
      }
    }
    return { width, height, data: out };
  }

  return { decode };
});
