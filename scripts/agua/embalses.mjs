/*
 * Genera src/shared/embalses.js: los datos fijos de cada embalse del Boletín
 * Hidrológico (ubicación, río, tipo de presa, altura, longitud de coronación,
 * superficie, provincias y titular), tomados del Inventario de Presas y
 * Embalses (SNCZI-IPE) de MITECO.
 *
 * Fuentes (MITECO, reutilizables citándolas):
 *  - Presas (puntos, ETRS89): ubicación, cauce, tipo, altura, coronación, titular.
 *  - Embalses (polígonos, ETRS89): superficie y provincias. Del .shp solo
 *    se usa el área de los polígonos cuando la superficie del .dbf no sirve.
 *  - Boletín Hidrológico (BD-Embalses.mdb): la lista de embalses y su
 *    demarcación; se usan los de la fecha más reciente.
 *
 * Cada embalse del Boletín se empareja con un registro de Presas por nombre,
 * demarcación y capacidad (ver `match`); los que no salen solos se resuelven
 * a mano en OVERRIDES. El inventario tiene datos defectuosos (capacidades en
 * litros, superficies absurdas, alturas de relleno): ver `fixCap`, `surfaceHa`.
 *
 * Uso (una vez; el resultado se guarda en el repositorio):
 *   node scripts/agua/embalses.mjs [--local <carpeta con pre/ emb/ bd/>]
 * Sin --local descarga los tres ZIP de MITECO.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import MDBReader from 'mdb-reader';
import { norm, num } from './lib.mjs';

const require = createRequire(import.meta.url);
const { laea } = require('../../src/main/opera.js');
const CUENCAS = require('../../src/shared/cuencas.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'src/shared/embalses.js');

const UA = 'Chubasco (+https://github.com/lalesena/chubasco)';
const MITECO = 'https://www.miteco.gob.es/content/dam/miteco/es/agua';
const URLS = {
  pre: `${MITECO}/servicios/egis_presa_geoetrs89_tcm30-175857.zip`,
  emb: `${MITECO}/servicios/egis_embalse_geoetrs89_tcm30-175729.zip`,
  bd: `${MITECO}/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico/Historico-de-embalses/BD-Embalses.zip`
};

// ---------------------------------------------------------------------------
// Correcciones a mano
//
// Nombre del Boletín → { presa: CODIGO de Presas, embalse?: CODIGO de
// Embalses, system?: true }, o null si no hay una ubicación razonable.
// «system»: el Boletín suma varios embalses pequeños en uno solo; se toma la
// mayor de sus presas (sus datos son los de esa presa, no los del conjunto).
// Los que se emparejan solos con otra presa también pueden corregirse aquí.

const OVERRIDES = {
  // El nombre del Boletín no se parece al del inventario.
  'Alcántara': { presa: '3100131', embalse: 1197 }, // José María de Oriol
  'Agavanzal, Nª Sª de': { presa: '2490019', embalse: 1544 },
  'Chandrexa': { presa: '1320025', embalse: 647 }, // Chandreja
  'Villagudín': { presa: '14150011', embalse: 2469 }, // Vilagudín
  'San. Estevo': { presa: '1320029', embalse: 2011 }, // San Esteban
  'Sta Uxia': { presa: '14150009' }, // Santa Uxía = Santa Eugenia (Xallas)
  'Olivargas': { presa: '4210017', embalse: 2171 }, // Sotiel-Olivargas
  'La Cabezuela': { presa: '4130005', embalse: 1336 }, // Marisánchez (Jabalón), única de ~43 hm³ que falta
  'Santillana': { presa: '3280002', embalse: 1324 }, // Manzanares el Real (la «Santillana» del inventario está inundada)
  'Pto. Vallehermoso': { presa: '4130055', embalse: 1811 },
  'Torre de Abrahán': { presa: '4130014', embalse: 2261 },
  'Conde Guadalhorce': { presa: '6290035', embalse: 725 },
  'Cedillo': { presa: '3100117', embalse: 611 },
  'Ip': { presa: '9220067', embalse: 1150 }, // Ibón de Ip
  'Santa María de Belsué': { presa: '9220090', embalse: 2083 },
  'Terroba': { presa: '9260015', embalse: 2224 }, // Soto Terroba
  'Sant Pons': { presa: '10250001', embalse: 2044 }, // Sant Ponç
  'Riocobo': { presa: '14270002', embalse: 1914 }, // Río Covo
  'Boadella': { presa: '10170002', embalse: 351 }, // Darnius Boadella (la presa principal, en la Muga)
  // Varias presas con el mismo nombre: la principal.
  'Contreras': { presa: '8460021', embalse: 731 }, // la otra (8460022, 43 m) parece la presa antigua
  // Dos entradas del Boletín (82 y 5 hm³) para la misma presa recrecida.
  'Cañón de Santolea': { presa: '9440010', embalse: 2100 },
  'Santolea': { presa: '9440010', embalse: 2100 },
  // Sistemas: el Boletín suma varios embalses.
  'Guadalhorce-Guadalteba': { presa: '6290026', embalse: 1075, system: true }, // Guadalteba (153) + Guadalhorce (126)
  'Alsa - Mediajo': { presa: '1390004', embalse: 126, system: true }, // Alsa-Torina (22,9) + Mediajo (10)
  'Sistema Aguas Limpias': { presa: '9220091', embalse: 1881, system: true }, // Respomuso (17,9)
  'Sistema Alto Caldarés': { presa: '9220010', embalse: 232, system: true }, // Bachimaña Alto (7)
  'Sistema Capdella': { presa: '9250037', embalse: 1325, system: true }, // lagos de la Vall Fosca; el mayor, Estany de Mar (13,6)
  'Sistema Lagos Espot': { presa: '9250014', embalse: 1213, system: true }, // el mayor, Estany Negre (6,6)
  // Sin una presa identificable (suma de pequeños lagos de alta montaña).
  'Sistema Valle de Arán': null
};

// ---------------------------------------------------------------------------
// Lectura de ficheros

const decoder = new TextDecoder('windows-1252');

/** DBF (dBase III): filas como objetos, con las cadenas recortadas. */
function readDbf(buf, label) {
  const n = buf.readUInt32LE(4), headerLen = buf.readUInt16LE(8), recLen = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32; buf[o] !== 0x0d; o += 32) {
    fields.push({ name: buf.toString('latin1', o, o + 11).replace(/\0.*$/, ''), type: String.fromCharCode(buf[o + 11]), len: buf[o + 16] });
  }
  // Sin .cpg: el byte 29 es el «language driver» (0x58 = Windows-1252). Si los
  // bytes fueran UTF-8 válido (no lo son), se usaría tal cual.
  let utf8 = true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(headerLen)); } catch { utf8 = false; }
  const dec = utf8 ? new TextDecoder('utf-8') : decoder;
  console.log(`${label}: ${n} registros, codificación ${utf8 ? 'UTF-8' : `Windows-1252 (driver 0x${buf[29].toString(16)})`}, actualizado ${1900 + buf[1]}-${String(buf[2]).padStart(2, '0')}-${String(buf[3]).padStart(2, '0')}`);
  const rows = [];
  for (let i = 0; i < n; i++) {
    let o = headerLen + i * recLen;
    if (buf[o] === 0x2a) { rows.push(null); continue; } // registro borrado (el índice se mantiene alineado con el .shp)
    o++;
    const r = {};
    for (const f of fields) {
      const s = dec.decode(buf.subarray(o, o + f.len)).replace(/\0/g, '').trim();
      o += f.len;
      r[f.name] = f.type === 'N' || f.type === 'F' ? (s === '' ? null : Number(s)) : s;
    }
    rows.push(r);
  }
  return { rows, updated: new Date(Date.UTC(1900 + buf[1], buf[2] - 1, buf[3])) };
}

/** SHP de puntos (tipo 1): [lon, lat] por registro, en el orden del .dbf. */
function readShpPoints(buf) {
  if (buf.readInt32LE(32) !== 1) throw new Error('El .shp de presas no es de puntos');
  const pts = [];
  for (let o = 100; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o + 4) * 2;
    pts.push(buf.readInt32LE(o + 8) === 1 ? [buf.readDoubleLE(o + 12), buf.readDoubleLE(o + 20)] : null);
    o += 8 + len;
  }
  return pts;
}

async function fetchBuf(url) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (i >= 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

/**
 * Ficheros {nombre → Buffer} de los ZIP de MITECO cuyo nombre cumple `re`
 * (o los de la carpeta local `<local>/<kind>`).
 */
async function loadFiles(kind, re, local) {
  if (local) {
    const dir = path.join(local, kind);
    const names = (await fs.readdir(dir)).filter((f) => re.test(f));
    return Object.fromEntries(await Promise.all(names.map(async (f) => [f, await fs.readFile(path.join(dir, f))])));
  }
  console.log('descargando', URLS[kind]);
  const files = unzipSync(await fetchBuf(URLS[kind]), { filter: (f) => re.test(f.name) });
  return Object.fromEntries(Object.entries(files).map(([f, d]) => [f, Buffer.from(d.buffer, d.byteOffset, d.byteLength)]));
}
const pick = (files, re, what) => {
  const name = Object.keys(files).find((f) => re.test(f));
  if (!name) throw new Error(`${what}: falta el fichero ${re}`);
  return files[name];
};

/**
 * Embalses del Boletín en su última fecha: {basin, name, cap, elec}.
 * La tabla está ordenada por embalse y fecha (unas 2000 filas cada uno) y leerla
 * entera tarda un minuto: se lee solo la columna de fechas (rápido) y, de las
 * filas con la fecha más reciente, las columnas completas.
 */
function readBoletin(buf) {
  const db = new MDBReader(buf);
  const table = db.getTable(db.getTableNames().find((n) => /Datos Embalses/i.test(n)) || db.getTableNames()[0]);
  const dates = table.getData({ columns: ['FECHA'] }).map((r) => +new Date(r.FECHA));
  const last = dates.reduce((m, t) => (t > m ? t : m), 0);
  const byAmbito = new Map();
  for (const b of CUENCAS.basins) for (const a of b.ambitos) byAmbito.set(norm(a), b.id);
  const out = [];
  dates.forEach((t, i) => {
    if (t !== last) return;
    const r = table.getData({ rowOffset: i, rowLimit: 1 })[0];
    const basin = byAmbito.get(norm(r.AMBITO_NOMBRE));
    if (!basin) throw new Error(`Ámbito sin cuenca: ${r.AMBITO_NOMBRE}`);
    out.push({ basin, name: String(r.EMBALSE_NOMBRE).trim(), cap: num(r.AGUA_TOTAL), elec: String(r.ELECTRICO_FLAG) === '1' });
  });
  return { date: new Date(last).toISOString().slice(0, 10), reservoirs: out };
}

// ---------------------------------------------------------------------------
// Demarcaciones

// Las que no coinciden por nombre con la demarcación de cuencas.js.
const DEMARC_ALIAS = { cuencasmediterraneasandaluzas: 'ES060', cuencasinternasdecataluna: 'ES100' };
const basinByName = new Map();
for (const b of CUENCAS.basins) { basinByName.set(norm(b.name), b.id); for (const a of b.ambitos) basinByName.set(norm(a), b.id); }
const demarcBasin = (d) => { const k = norm(String(d).split('\n')[0]); return basinByName.get(k) || DEMARC_ALIAS[k] || null; };

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/**
 * Demarcación de un punto (para los registros sin DEMARC): las de cuencas.js,
 * recortadas a tierra y simplificadas, así que se prueba también alrededor
 * (hasta ~7 km) por si la presa cae justo en el límite o en la frontera.
 */
function basinAt([x, y]) {
  const at = (px, py) => {
    for (const b of CUENCAS.basins) {
      for (const poly of b.polygons) if (inRing(poly[0], px, py) && !poly.slice(1).some((h) => inRing(h, px, py))) return b.id;
    }
    return null;
  };
  for (const d of [0, 0.03, 0.06]) {
    for (const [dx, dy] of d ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[0, 0]]) {
      const id = at(x + dx * d, y + dy * d);
      if (id) return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nombres

const ARTICLES = 'el|la|los|las|os|as|o|a|es|sa';
const ABBR = { sta: 'santa', sto: 'santo', pto: 'puerto' };

/**
 * Claves de comparación de un nombre: sin tildes ni mayúsculas, «X, La» → «La
 * X», con y sin el paréntesis (y solo el paréntesis), y cada parte de «A - B»
 * o «A ó B» por separado. Cada clave son solo letras; la de «La X» sin el
 * artículo es «X» y, con él, «@laX» (distingue «Peña, La» de «Pena»).
 */
function keys(name) {
  const s = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const paren = [...s.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  const forms = [s.replace(/[()]/g, ' '), s.replace(/\([^)]*\)/g, ' '), ...paren];
  const out = new Set();
  const letters = (x) => x.replace(/[^a-z]/g, '');
  const add = (p) => {
    p = p.replace(/^[\s\-.,;:]+|[\s\-.,;:]+$/g, '');
    p = p.replace(new RegExp(`^(.+?)\\s*,\\s*(${ARTICLES}|l')\\s*$`), (_, x, a) => (a === "l'" ? a : `${a} `) + x);
    p = p.replace(/\b[a-z]+\b\.?/g, (w) => ABBR[w.replace('.', '')] || w);
    p = p.replace(/^(embalse|presa|sistema) (de |del )?/, '').replace(/\b(nª sª|nuestra senora) de\b/g, '');
    if (letters(p).length >= 3) out.add('@' + letters(p));
    p = p.replace(new RegExp(`^(${ARTICLES})\\s+`), '').replace(/^l'\s*/, '');
    if (letters(p).length >= 3) out.add(letters(p));
  };
  for (const f of forms) {
    add(f);
    for (const part of f.split(/\s+-\s+|\s*\/\s*|\s+o\s+/)) add(part);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Limpieza de valores

const stripAccents = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const SMALL = new Set(['ó', 'de', 'del', 'la', 'las', 'les', 'los', 'el', 'y', 'e', 'o', 'u', 'en', 'a', 'da', 'do', 'das', 'dos', 'per', 'por', 'ou', 'als', 'al']);
const ACRONYMS = new Set(['sdg', 'cb', 'hc']);
// Tildes que faltan en los textos en mayúsculas del inventario (además de las
// del vocabulario del Boletín, ver `restoreAccents`).
const ACCENTS = {
  rio: 'río', generacion: 'generación', confederacion: 'confederación', hidrografica: 'hidrográfica', hidraulica: 'hidráulica',
  hidroelectrica: 'hidroeléctrica', electrica: 'eléctrica', electricas: 'eléctricas', cantabrico: 'cantábrico', metalicos: 'metálicos',
  espanol: 'español', energia: 'energía', energias: 'energías', corporacion: 'corporación', andalucia: 'andalucía', consejeria: 'consejería',
  ordenacion: 'ordenación', gestion: 'gestión', administracion: 'administración', diputacion: 'diputación', alimentacion: 'alimentación', caceres: 'cáceres',
  cordoba: 'córdoba', jaen: 'jaén', malaga: 'málaga', avila: 'ávila', leon: 'león', cadiz: 'cádiz', almeria: 'almería',
  guipuzcoa: 'guipúzcoa', guadalentin: 'guadalentín'
};
// Palabras con tilde del vocabulario del Boletín (sus nombres y ámbitos sí la llevan):
// «jabalon» → «jabalón». Se descartan las que el Boletín también escribe sin tilde.
const VOCAB = new Map();
function buildVocab(names) {
  const plain = new Set();
  for (const n of names) {
    for (const w of n.toLowerCase().split(/[^\p{L}ª]+/u).filter(Boolean)) {
      const k = stripAccents(w);
      if (k === w) plain.add(w); else if (!VOCAB.has(k)) VOCAB.set(k, w);
    }
  }
  for (const w of plain) VOCAB.delete(w);
}
const restoreAccents = (w) => {
  const k = stripAccents(w);
  return k !== w ? w : ACCENTS[k] || VOCAB.get(k) || w;
};
function titleCase(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim().split(' ').map((token, i) => {
    const [, raw, tail] = /^(.*?)([.,;:]*)$/.exec(token); // la puntuación final no cuenta para buscar la tilde
    const w = restoreAccents(raw);
    if (ACRONYMS.has(w)) return w.toUpperCase() + tail;
    if (i > 0 && SMALL.has(w)) return w + tail;
    if (i > 0 && /^(ii|iii|iv|vi|vii|viii|ix|x)$/.test(w)) return w.toUpperCase() + tail;
    const pre = /^([dl]['’])(.+)$/.exec(w); // «d'aiguamòg» → «d'Aiguamòg»
    if (pre && i > 0) return pre[1] + pre[2].replace(/^\p{L}/u, (c) => c.toUpperCase()) + tail;
    return w.replace(/(^|[-/(.'’])(\p{L})/gu, (_, a, c) => a + c.toUpperCase()) + tail;
  }).join(' ');
}

const SUFFIX = /[,\s]+(s\.?\s?a\.?\s?u\.?|s\.?\s?l\.?\s?u\.?|s\.?\s?a\.?|s\.?\s?l\.?|s\.?\s?c\.?|s\.?\s?coop\.?|sau|slu)\.?$/i;
function cleanOwner(titular) {
  const list = String(titular).split('\n').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return null;
  // «ESTADO / CONFEDERACION HIDROGRAFICA DEL TAJO»: lo útil es el organismo.
  let o = /^(estado|administracion (general|del estado)|comunidad autonoma)$/i.test(stripAccents(list[0])) && list[1] ? list[1] : list[0];
  o = o.replace(SUFFIX, '').replace(SUFFIX, '').trim();
  if (o === o.toUpperCase() || o === o.toLowerCase()) o = titleCase(o);
  else {
    // Ya en minúsculas y mayúsculas, pero a veces sin tildes («Andalucia»).
    o = o.split(' ').map((w) => {
      const core = w.replace(/[.,;:]+$/, ''), r = restoreAccents(core.toLowerCase());
      return r === core.toLowerCase() ? w : (core[0] === core[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r) + w.slice(core.length);
    }).join(' ');
  }
  o = o.replace(/\.\s+C\.\s.*$/, ''); // «Generalitat Valenciana. C. Agricultura…» → la Generalitat
  const head = o.split(', ')[0]; // «Junta de Extremadura, Consejería de Fomento…» → el organismo
  if (head.includes(' ') && head.length < o.length) o = head;
  return o || null;
}

// Provincias con nombre bilingüe («Alacant/Alicante», «Castellón/Castelló»): la forma castellana.
const PROVINCES = {
  'coruna, a': 'A Coruña', 'rioja, la': 'La Rioja', 'palmas, las': 'Las Palmas', 'balears, illes': 'Baleares', 'illes balears': 'Baleares',
  alacant: 'Alicante', alicante: 'Alicante', castello: 'Castellón', castellon: 'Castellón', valencia: 'Valencia',
  araba: 'Álava', alava: 'Álava', bizkaia: 'Vizcaya', vizcaya: 'Vizcaya', gipuzkoa: 'Guipúzcoa', guipuzcoa: 'Guipúzcoa'
};
function cleanProvinces(list) {
  const out = [];
  for (const raw of String(list).split('\n').map((x) => x.trim()).filter(Boolean)) {
    const parts = raw.split('/').map((x) => x.trim());
    const known = parts.map((x) => PROVINCES[stripAccents(x).toLowerCase()]).find(Boolean) || PROVINCES[stripAccents(raw).toLowerCase()];
    const p = known || parts[0];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// Tipo de presa: etiqueta original de MITECO → código.
const TYPES = {
  gravity: { label: 'Presa de gravedad (hormigón o mampostería)', from: ['Presa de fábrica de gravedad (hormigón vibrado)', 'Presa de fábrica de gravedad (hormigón compactado)', 'Presa de fábrica de mampostería'] },
  arch: { label: 'Presa de bóveda', from: ['Presa de fábrica de bóveda', 'Presa de fábrica de bóvedas múltiples'] },
  archGravity: { label: 'Presa de arco-gravedad', from: ['Presa de fábrica de arco-gravedad'] },
  buttress: { label: 'Presa de contrafuertes', from: ['Presa de fábrica de contrafuertes'] },
  earth: { label: 'Presa de materiales sueltos (homogénea o zonificada)', from: ['Presa de materiales sueltos homogénea', 'Presa de materiales sueltos zonificada o de núcleo'] },
  rockfill: { label: 'Presa de materiales sueltos con pantalla', from: ['Presa de materiales sueltos de pantalla de hormigón', 'Presa de materiales sueltos de pantalla asfáltica', 'Presa de materiales sueltos de pantalla de material sintético', 'Presa de materiales sueltos de pantalla de mampostería'] },
  mixed: { label: 'Presa mixta', from: ['Presa mixta'] },
  other: { label: 'Otro tipo de presa', from: ['Presa móvil o hinchable', 'Presa de fábrica de gaviones'] }
};
const TYPE_CODE = new Map(Object.entries(TYPES).flatMap(([code, t]) => t.from.map((f) => [f, code])));

// ---------------------------------------------------------------------------
// Emparejamiento

const fixCap = (v) => (v > 1e4 ? v / 1e9 : v); // algunas capacidades vienen en litros (16370000000 en vez de 16,37)
const capOf = (r) => fixCap(r.NMN_CAPAC || 0);
const okCap = (cap, other, lo, hi) => {
  const c = capOf(other), r = c ? cap / c : Infinity;
  return (r >= lo && r <= hi) || Math.abs(cap - c) < 5;
};
// Cuanto menor, mejor: mismo nombre exacto (con artículo), capacidad parecida,
// en explotación y con altura conocida.
const score = (b, p) => Math.abs(Math.log((capOf(p) || 0.001) / b.cap)) + (p.FASE === 'Explotación' ? 0 : 0.3) + (p.ALT_CIMIEN ? 0 : 0.05) - ([...p.k].some((k) => k[0] === '@' && b.k.has(k)) ? 0.5 : 0);

function match(b, presas) {
  const own = b.k;
  const here = presas.filter((p) => p.basin === b.basin);
  const t1 = here.filter((p) => okCap(b.cap, p, 0.5, 2) && [...p.k].some((k) => own.has(k)));
  if (t1.length) return { p: t1.sort((x, y) => score(b, x) - score(b, y))[0], how: 'nombre' };
  // Una clave contiene a la otra («Castrelo» / «Castrelo de Miño»), con una capacidad más ajustada.
  const t2 = here.filter((p) => okCap(b.cap, p, 0.7, 1.4) && [...p.k].some((k) => [...own].some((q) => q[0] !== '@' && k[0] !== '@' && q.length >= 5 && k.length >= 5 && (k.startsWith(q) || q.startsWith(k)))));
  if (t2.length) return { p: t2.sort((x, y) => score(b, x) - score(b, y))[0], how: 'parecido' };
  return null;
}

/**
 * Registro de Embalses de la presa: mismo nombre (el del Boletín o el de la
 * presa) y misma capacidad; si el nombre cambia («Rambla de Algeciras» /
 * «Algeciras, Rambla de»), el único de la misma demarcación con la misma
 * capacidad y alguna provincia en común.
 */
function matchEmbalse(b, p, embalses) {
  const own = new Set([...b.k, ...p.k]);
  const cap = capOf(p);
  const same = (e) => (!e.basin || e.basin === p.basin) && (Math.abs(capOf(e) - cap) < 0.05 * Math.max(cap, 1) || okCap(cap, e, 0.95, 1.05));
  const byName = embalses.filter((e) => same(e) && [...e.k].some((k) => own.has(k)));
  if (byName.length) return byName.sort((x, y) => Math.abs(capOf(x) - cap) - Math.abs(capOf(y) - cap))[0];
  const provs = new Set(cleanProvinces(p.PROVINCIA));
  const byCap = embalses.filter((e) => e.basin === p.basin && cap >= 1 && Math.abs(capOf(e) - cap) <= 0.002 * cap && cleanProvinces(e.PROVINCIA).some((x) => provs.has(x)));
  return byCap.length === 1 ? byCap[0] : null;
}

/**
 * Superficie del embalse (ha). NMN_SUP del inventario trae valores absurdos
 * (4,7e15) y algunos en ha en vez de m²: se acepta la interpretación cuya
 * profundidad media (capacidad / superficie) es plausible. Si hay polígono, su
 * área manda cuando el valor del inventario no se le parece (entre 0,5× y 2×).
 */
function surfaceHa(cap, nmnSup, polygonM2) { // nmnSup: valores del inventario (m²) por orden de preferencia
  const plausible = (ha) => ha >= 1 && ha <= 20000 && (cap * 1e6) / (ha * 1e4) >= 1.5 && (cap * 1e6) / (ha * 1e4) <= 150;
  const poly = polygonM2 >= 1e4 ? polygonM2 / 1e4 : null; // hay polígonos vacíos (área 0)
  let dbf = null;
  for (const v of nmnSup) {
    if (!(v > 0)) continue;
    dbf = [v / 1e4, v].find(plausible) ?? null;
    if (dbf !== null) break;
  }
  const ratio = dbf !== null && poly !== null ? dbf / poly : null;
  if (dbf !== null && (ratio === null || (ratio >= 0.5 && ratio <= 2))) return { ha: Math.round(dbf), from: 'inventario', ratio };
  if (poly !== null && plausible(poly)) return { ha: Math.round(poly), from: 'polígono', ratio };
  if (dbf !== null) return { ha: Math.round(dbf), from: 'inventario', ratio };
  return { ha: null };
}

/** Áreas (m²) de los polígonos de Embalses cuyo índice está en `wanted` (el orden del .shp es el del .dbf). */
function polygonAreas(buf, wanted) {
  if (buf.readInt32LE(32) !== 5) throw new Error('El .shp de embalses no es de polígonos');
  const proj = laea({ lat0: 40, lon0: -3 }); // equivalente: sirve para medir áreas
  const out = new Map();
  let i = 0;
  for (let o = 100; o + 8 <= buf.length; i++) {
    const len = buf.readUInt32BE(o + 4) * 2;
    if (wanted.has(i) && buf.readInt32LE(o + 8) === 5) {
      const base = o + 8, nParts = buf.readInt32LE(base + 36), nPts = buf.readInt32LE(base + 40);
      const parts = [];
      for (let k = 0; k < nParts; k++) parts.push(buf.readInt32LE(base + 44 + 4 * k));
      const ptsAt = base + 44 + 4 * nParts;
      let sum = 0; // anillos exteriores en un sentido y huecos en el otro: la suma firmada es el área
      parts.forEach((from, k) => {
        const to = k + 1 < nParts ? parts[k + 1] : nPts;
        let prev = null;
        for (let j = from; j < to; j++) {
          const q = proj.forward(buf.readDoubleLE(ptsAt + 16 * j + 8), buf.readDoubleLE(ptsAt + 16 * j));
          if (prev) sum += prev.e * q.n - q.e * prev.n;
          prev = q;
        }
      });
      out.set(i, Math.abs(sum / 2));
    }
    o += 8 + len;
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const local = args.includes('--local') ? path.resolve(args[args.indexOf('--local') + 1] || '') : null;
  if (args.includes('--local') && !args[args.indexOf('--local') + 1]) throw new Error('--local necesita una carpeta');

  const [filesPre, filesEmb, filesBd] = await Promise.all([
    loadFiles('pre', /\.(dbf|shp)$/i, local), loadFiles('emb', /\.(dbf|shp)$/i, local), loadFiles('bd', /\.mdb$/i, local)
  ]);
  const pre = readDbf(pick(filesPre, /\.dbf$/i, 'Presas'), 'Presas'), emb = readDbf(pick(filesEmb, /\.dbf$/i, 'Embalses'), 'Embalses');
  const pts = readShpPoints(pick(filesPre, /\.shp$/i, 'Presas'));
  const shpEmb = pick(filesEmb, /\.shp$/i, 'Embalses');
  const mdb = pick(filesBd, /\.mdb$/i, 'Boletín');
  if (pts.length !== pre.rows.length) throw new Error(`Presas: ${pre.rows.length} registros en el .dbf y ${pts.length} en el .shp`);
  const boletin = readBoletin(mdb);
  console.log(`Boletín: ${boletin.reservoirs.length} embalses a ${boletin.date}`);
  for (const b of boletin.reservoirs) b.k = keys(b.name);
  buildVocab([...boletin.reservoirs.map((b) => b.name), ...CUENCAS.basins.flatMap((b) => [b.name, ...b.ambitos])]);

  const presas = pre.rows.map((r, i) => r && { ...r, pt: pts[i], k: keys(r.NOMBRE) }).filter(Boolean);
  const embalses = emb.rows.map((r, i) => r && { ...r, idx: i, k: keys(r.NOMBRE) }).filter(Boolean);
  for (const p of presas) p.basin = demarcBasin(p.DEMARC) || (p.pt ? basinAt(p.pt) : null);
  for (const e of embalses) e.basin = demarcBasin(e.DEMARC);

  const demarcs = new Map();
  for (const r of [...pre.rows, ...emb.rows]) if (r) demarcs.set(r.DEMARC, demarcBasin(r.DEMARC));
  console.log('\nDEMARC → cuenca:');
  for (const [d, id] of [...demarcs].sort()) console.log(`  ${JSON.stringify(d).padEnd(40)} ${id || (d ? '(fuera de la cobertura)' : '(vacío: se deduce de la ubicación)')}`);

  const names = boletin.reservoirs.map((b) => b.name);
  if (new Set(names).size !== names.length) throw new Error('Hay nombres repetidos en el Boletín: la clave de OVERRIDES no basta');
  for (const k of Object.keys(OVERRIDES)) if (!names.includes(k)) throw new Error(`OVERRIDES: «${k}» no está en el Boletín`);
  const byCode = new Map(presas.map((p) => [p.CODIGO, p]));
  const byEmb = new Map(embalses.map((e) => [e.CODIGO, e]));

  const stats = { nombre: 0, parecido: 0, manual: 0, nula: 0, sin: [] };
  const items = {}, report = [], notes = { sinEmbalse: [], sinSuperficie: [], superficiePoligono: [], mismaPresa: new Map() };
  const usedTypes = new Set(), pending = [];

  for (const b of boletin.reservoirs) {
    let p, e, how, system = false;
    if (Object.hasOwn(OVERRIDES, b.name)) {
      const o = OVERRIDES[b.name];
      if (o === null) { stats.nula++; continue; }
      const auto = o.presa ? null : match(b, presas); // sin presa: la que sale sola, solo se corrige el embalse
      p = o.presa ? byCode.get(o.presa) : auto && auto.p;
      if (!p) throw new Error(`OVERRIDES «${b.name}»: no existe la presa ${o.presa}`);
      if (p.basin !== b.basin) throw new Error(`OVERRIDES «${b.name}»: la presa ${o.presa} es de ${p.basin}, no de ${b.basin}`);
      e = o.embalse !== undefined ? byEmb.get(o.embalse) : matchEmbalse(b, p, embalses);
      if (o.embalse !== undefined && !e) throw new Error(`OVERRIDES «${b.name}»: no existe el embalse ${o.embalse}`);
      how = 'manual'; system = !!o.system; stats.manual++;
    } else {
      const m = match(b, presas);
      if (!m) { stats.sin.push(`${b.basin}|${b.name} (${b.cap} hm³)`); continue; }
      p = m.p; how = m.how; stats[how]++;
      e = matchEmbalse(b, p, embalses);
    }
    if (!p.pt) throw new Error(`${b.name}: la presa ${p.CODIGO} no tiene coordenadas`);
    if (!e) notes.sinEmbalse.push(`${b.basin}|${b.name}`);

    const item = { lat: Math.round(p.pt[1] * 1e4) / 1e4, lon: Math.round(p.pt[0] * 1e4) / 1e4 };
    const river = p.CAUCE.replace(/\s+/g, ' ').trim();
    if (river) item.river = titleCase(river);
    const prov = cleanProvinces((e && e.PROVINCIA) || p.PROVINCIA);
    if (prov.length) item.prov = prov;
    // Los usos (USO) no se publican: el inventario los trae incompletos (casi
    // nunca «Riego», ni «Hidroeléctrico» en Alcántara o Aldeadávila).
    const type = TYPE_CODE.get(p.TIPO);
    if (type) { item.type = type; usedTypes.add(type); } else if (p.TIPO) console.warn(`  tipo desconocido «${p.TIPO}» (${b.name})`);
    if (p.ALT_CIMIEN >= 3 && p.ALT_CIMIEN <= 250) item.h = Math.round(p.ALT_CIMIEN * 10) / 10; // 1 m es un valor de relleno
    if (p.LONG_CORON > 0 && p.LONG_CORON <= 12000) item.crest = Math.round(p.LONG_CORON);
    pending.push({ b, p, e, item }); // la superficie se rellena al final (necesita los polígonos)
    const owner = cleanOwner(p.TITULAR);
    if (owner) item.owner = owner;
    // INFORME (la ficha del SNCZI) no se publica: esos enlaces llevan a un 404.
    if (system) item.system = true;
    items[`${b.basin}|${b.name}`] = item;

    const key = p.CODIGO;
    notes.mismaPresa.set(key, [...(notes.mismaPresa.get(key) || []), b.name]);
    report.push({ b, p, e, how, ratio: capOf(p) ? b.cap / capOf(p) : Infinity });
  }

  // -- Superficies ------------------------------------------------------------
  const areas = polygonAreas(shpEmb, new Set(pending.filter((x) => x.e).map((x) => x.e.idx)));
  const ratios = [];
  for (const { b, p, e, item } of pending) {
    const poly = e ? areas.get(e.idx) : null;
    const s = surfaceHa(capOf(p) || b.cap, [e && e.NMN_SUP, p.NMN_SUP], poly);
    if (s.ratio) ratios.push(s.ratio);
    if (s.ha) { item.surf = s.ha; if (s.from === 'polígono') notes.superficiePoligono.push(`${b.basin}|${b.name} ${s.ha} ha`); }
    else notes.sinSuperficie.push(`${b.basin}|${b.name} (inventario ${e && e.NMN_SUP}/${p.NMN_SUP} m², polígono ${poly && Math.round(poly / 1e4)} ha, capacidad ${capOf(p)} hm³)`);
  }

  ratios.sort((x, y) => x - y);
  console.log(`\nSuperficie: inventario / polígono en ${ratios.length} embalses (mediana ${ratios[ratios.length >> 1]?.toFixed(3)}, 10 % ${ratios[Math.floor(ratios.length * 0.1)]?.toFixed(3)}, 90 % ${ratios[Math.floor(ratios.length * 0.9)]?.toFixed(3)})`);

  // -- Verificación -----------------------------------------------------------
  const total = boletin.reservoirs.length;
  const matched = stats.nombre + stats.parecido + stats.manual;
  console.log(`\nEmparejados: ${matched} de ${total} (por nombre ${stats.nombre}, por nombre parecido ${stats.parecido}, a mano ${stats.manual}); sin ubicación a propósito: ${stats.nula}; sin emparejar: ${stats.sin.length}`);
  if (stats.sin.length) console.log('Sin emparejar:\n  ' + stats.sin.join('\n  '));
  const fmt = (r) => `${(r.b.basin + '|' + r.b.name).padEnd(44)} Boletín ${String(r.b.cap).padStart(6)} hm³  ↔  ${r.p.NOMBRE} (${r.p.CODIGO}) ${String(capOf(r.p)).padStart(8)} hm³  × ${r.ratio.toFixed(2)}  [${r.how}]`;
  console.log('\nCapacidad fuera de 0,8–1,25 (revisar a ojo):');
  for (const r of report.filter((x) => x.ratio < 0.8 || x.ratio > 1.25)) console.log('  ' + fmt(r));
  console.log('\nEmparejados por nombre, pero no idéntico (revisar):');
  for (const r of report.filter((x) => x.how === 'nombre' && ![...x.p.k].some((k) => k[0] === '@' && x.b.k.has(k)))) console.log('  ' + fmt(r));
  console.log('\nEmparejados por nombre parecido (revisar):');
  for (const r of report.filter((x) => x.how === 'parecido')) console.log('  ' + fmt(r));
  console.log('\nA mano:');
  for (const r of report.filter((x) => x.how === 'manual')) console.log('  ' + fmt(r));
  const dup = [...notes.mismaPresa].filter(([, v]) => v.length > 1);
  if (dup.length) console.log('\nVarios embalses del Boletín en la misma presa:\n  ' + dup.map(([c, v]) => `${c}: ${v.join(', ')}`).join('\n  '));
  if (notes.sinEmbalse.length) console.log(`\nSin registro en Embalses (${notes.sinEmbalse.length}; provincias de la presa):\n  ${notes.sinEmbalse.join(', ')}`);
  if (notes.superficiePoligono.length) console.log(`\nSuperficie del polígono (el valor del inventario no sirve, ${notes.superficiePoligono.length}):\n  ${notes.superficiePoligono.join(', ')}`);
  if (notes.sinSuperficie.length) console.log(`\nSin superficie fiable (${notes.sinSuperficie.length}):\n  ${notes.sinSuperficie.join('\n  ')}`);

  // -- Salida -----------------------------------------------------------------
  const order = new Map(CUENCAS.basins.map((x, i) => [x.id, i]));
  const keysSorted = Object.keys(items).sort((x, y) => order.get(x.split('|')[0]) - order.get(y.split('|')[0]) || x.localeCompare(y, 'es'));
  const typesTable = Object.fromEntries(Object.entries(TYPES).filter(([c]) => usedTypes.has(c)).map(([c, t]) => [c, t.label]));
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const when = `${months[pre.updated.getUTCMonth()]} de ${pre.updated.getUTCFullYear()}`;
  const attribution = `MITECO, Inventario de Presas y Embalses (SNCZI-IPE), datos de ${when}, y Boletín Hidrológico`;

  const ORDER = ['lat', 'lon', 'river', 'prov', 'type', 'h', 'crest', 'surf', 'owner', 'system'];
  const lit = (v) => (Array.isArray(v) ? `[${v.map(lit).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}:${lit(x)}`).join(',')}}` : JSON.stringify(v));
  const row = (item) => lit(Object.fromEntries(ORDER.filter((k) => item[k] !== undefined).map((k) => [k, item[k]])));
  const text = `/*
 * Datos fijos de los embalses del Boletín Hidrológico (ubicación, río, presa,
 * superficie, provincias, titular). Generado con
 * scripts/agua/embalses.mjs; no editar a mano. Regenerar: node scripts/agua/embalses.mjs
 * Fuente: MITECO, Inventario de Presas y Embalses (SNCZI-IPE); embalses del
 * Boletín Hidrológico de ${boletin.date}.
 * items: «<cuenca>|<nombre en el Boletín>». lat/lon: la presa (ETRS89); h:
 * altura sobre cimientos (m); crest: coronación (m); surf: ha; type: código
 * de la tabla types; system: el Boletín suma varios embalses (datos de la
 * mayor presa).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RA_EMBALSES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
  attribution: ${JSON.stringify(attribution)},
  types: ${lit(typesTable)},
  items: {
${keysSorted.map((k) => `${JSON.stringify(k)}:${row(items[k])}`).join(',\n')}
  }
  };
});
`;
  await fs.writeFile(OUT, text);
  console.log(`\n${path.relative(ROOT, OUT)}: ${keysSorted.length} embalses, ${Buffer.byteLength(text)} bytes (${(Buffer.byteLength(text) / 1024).toFixed(1)} KiB)`);
  console.log('tipos:', JSON.stringify(typesTable));
}

main().catch((e) => { console.error(e); process.exit(1); });
