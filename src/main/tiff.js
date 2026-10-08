// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
/*
 * Lector mínimo de GeoTIFF en mosaicos (Cloud Optimized GeoTIFF), lo justo
 * para el compuesto de radar europeo OPERA: mosaicos con o sin compresión
 * DEFLATE, muestras float32 intercaladas y vistas reducidas (overviews).
 * Pensado para leer por trozos (peticiones HTTP Range): primero la
 * cabecera y después solo los mosaicos necesarios. Funciona igual en Node
 * y en el navegador (DecompressionStream).
 */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, samples: 277, planar: 284, predictor: 317,
  tileWidth: 322, tileHeight: 323, tileOffsets: 324, tileByteCounts: 325, sampleFormat: 339,
  pixelScale: 33550, tiepoint: 33922, geoKeys: 34735, geoDoubles: 34736, metadata: 42112, nodata: 42113
};
// GeoKeys de la proyección (GeoTIFF 1.0).
const GEOKEY = { coordTrans: 3075, falseEasting: 3082, falseNorthing: 3083, centerLon: 3088, centerLat: 3089, semiMajor: 2057, invFlattening: 2059 };
const CT_LAMBERT_AZIM_EQUAL_AREA = 10;

class NeedMore extends Error {
  constructor(bytes) { super(`La cabecera ocupa más de lo leído (${bytes} bytes)`); this.bytes = bytes; }
}

/**
 * Lee la cabecera a partir de los primeros bytes del fichero. Si no
 * bastan, lanza NeedMore con cuántos bytes hacen falta.
 */
function parseHeader(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) throw new Error('TIFF no válido');
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('Solo se admite TIFF clásico (no BigTIFF)');
  const need = (end) => { if (end > b.length) throw new NeedMore(Math.max(end, b.length * 2)); };

  function values(type, count, at) {
    const size = TYPE_SIZE[type];
    if (!size) return [];
    need(at + size * count);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = at + i * size;
      out[i] = type === 3 ? u16(o) : type === 4 ? u32(o) : type === 11 ? dv.getFloat32(o, le)
        : type === 12 ? dv.getFloat64(o, le) : type === 8 ? dv.getInt16(o, le) : type === 9 ? dv.getInt32(o, le) : b[o];
    }
    return out;
  }

  const ifds = [];
  let first = null;
  for (let off = u32(4); off && ifds.length < 16;) {
    need(off + 2);
    const n = u16(off);
    need(off + 2 + n * 12 + 4);
    const tags = new Map();
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const type = u16(e + 2), count = u32(e + 4);
      const at = (TYPE_SIZE[type] || 0) * count <= 4 ? e + 8 : u32(e + 8);
      if (type === 2) { need(at + count); tags.set(u16(e), new TextDecoder('latin1').decode(b.subarray(at, at + count)).replace(/\0+$/, '')); }
      else tags.set(u16(e), values(type, count, at));
    }
    const one = (t, d) => (tags.has(t) ? tags.get(t)[0] : d);
    const ifd = {
      width: one(TAG.width), height: one(TAG.height),
      tileWidth: one(TAG.tileWidth), tileHeight: one(TAG.tileHeight),
      samples: one(TAG.samples, 1), bits: one(TAG.bits, 8), sampleFormat: one(TAG.sampleFormat, 1),
      compression: one(TAG.compression, 1), predictor: one(TAG.predictor, 1), planar: one(TAG.planar, 1),
      tileOffsets: tags.get(TAG.tileOffsets), tileByteCounts: tags.get(TAG.tileByteCounts),
      nodata: tags.has(TAG.nodata) ? parseFloat(tags.get(TAG.nodata)) : null
    };
    if (!ifd.tileWidth || !ifd.tileOffsets) throw new Error('Solo se admiten TIFF en mosaicos');
    ifd.tilesAcross = Math.ceil(ifd.width / ifd.tileWidth);
    ifd.tilesDown = Math.ceil(ifd.height / ifd.tileHeight);
    ifds.push(ifd);
    if (!first) first = tags;
    off = u32(off + 2 + n * 12);
  }
  if (!first) throw new Error('TIFF sin imágenes');

  // Georreferencia de la imagen principal; las vistas reducidas cubren lo mismo.
  const scale = first.get(TAG.pixelScale), tie = first.get(TAG.tiepoint);
  const geo = scale && tie ? { originX: tie[3] - tie[0] * scale[0], originY: tie[4] + tie[1] * scale[1], pixelX: scale[0], pixelY: scale[1] } : null;
  const keys = first.get(TAG.geoKeys), doubles = first.get(TAG.geoDoubles) || [];
  if (geo && keys) {
    const key = new Map();
    for (let i = 4; i + 3 < keys.length; i += 4) {
      const [id, loc, , at] = keys.slice(i, i + 4);
      key.set(id, loc === 0 ? at : loc === TAG.geoDoubles ? doubles[at] : null);
    }
    if (key.get(GEOKEY.coordTrans) === CT_LAMBERT_AZIM_EQUAL_AREA) {
      geo.laea = {
        lat0: key.get(GEOKEY.centerLat), lon0: key.get(GEOKEY.centerLon),
        falseEasting: key.get(GEOKEY.falseEasting) || 0, falseNorthing: key.get(GEOKEY.falseNorthing) || 0,
        a: key.get(GEOKEY.semiMajor) || 6378137, invFlattening: key.get(GEOKEY.invFlattening) || 298.257223563
      };
    }
  }
  return { ifds, geo, metadata: first.get(TAG.metadata) || '' };
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Descomprime un mosaico y devuelve la primera muestra de cada píxel como
 * Float32Array (tileWidth × tileHeight).
 */
async function decodeTile(ifd, bytes) {
  if (ifd.bits !== 32 || ifd.sampleFormat !== 3) throw new Error('Solo se admiten muestras float32');
  if (ifd.planar !== 1 || ifd.predictor !== 1) throw new Error('Formato de mosaico no admitido');
  let raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (ifd.compression === 8 || ifd.compression === 32946) raw = await inflate(raw);
  else if (ifd.compression !== 1) throw new Error(`Compresión TIFF no admitida (${ifd.compression})`);
  const n = ifd.tileWidth * ifd.tileHeight;
  if (raw.length < n * ifd.samples * 4) throw new Error('Mosaico incompleto');
  // Copia alineada; TIFF "II" es little-endian, como todas las plataformas actuales.
  const all = new Float32Array(raw.slice(0, n * ifd.samples * 4).buffer);
  if (ifd.samples === 1) return all;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = all[i * ifd.samples];
  return out;
}

module.exports = { parseHeader, decodeTile, NeedMore };
