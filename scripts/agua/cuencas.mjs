// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Genera src/shared/cuencas.js: los límites de las demarcaciones
 * hidrográficas de la España peninsular y Baleares (las que cubre el radar
 * OPERA), recortados a tierra firme y simplificados para el mapa.
 *
 *  - Límites: Agencia Europea de Medio Ambiente, WISE WFD 2022 (CC BY 4.0).
 *    Incluyen las aguas costeras; se recortan con la costa de Natural Earth
 *    (dominio público).
 *  - Cada demarcación se empareja con los «ámbitos» del Boletín Hidrológico
 *    de MITECO (las cuencas internas del País Vasco van con el Cantábrico
 *    Oriental, que es su demarcación).
 *
 * Uso (una vez; el resultado se guarda en el repositorio):
 *   node scripts/agua/cuencas.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pc from 'polygon-clipping';

const require = createRequire(import.meta.url);
const { laea } = require('../../src/main/opera.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EEA = "https://water.discomap.eea.europa.eu/arcgis/rest/services/WISE_WFD/WFD2022_RiverBasinDistrict_WM/MapServer/0/query?where=countryCode='ES'&outFields=thematicIdIdentifier,nameText&outSR=4326&maxAllowableOffset=0.004&f=geojson";
const LAND = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson';

// Demarcación → nombre en la app y ámbitos del Boletín Hidrológico.
const BASINS = {
  ES010: { name: 'Miño-Sil', ambitos: ['Miño - Sil'] },
  ES014: { name: 'Galicia Costa', ambitos: ['Galicia Costa'] },
  ES018: { name: 'Cantábrico Occidental', ambitos: ['Cantábrico Occidental'] },
  ES017: { name: 'Cantábrico Oriental', ambitos: ['Cantábrico Oriental', 'Cuencas Internas del País Vasco'] },
  ES020: { name: 'Duero', ambitos: ['Duero'] },
  ES030: { name: 'Tajo', ambitos: ['Tajo'] },
  ES040: { name: 'Guadiana', ambitos: ['Guadiana'] },
  ES064: { name: 'Tinto, Odiel y Piedras', ambitos: ['Tinto, Odiel y Piedras'] },
  ES050: { name: 'Guadalquivir', ambitos: ['Guadalquivir'] },
  ES063: { name: 'Guadalete y Barbate', ambitos: ['Guadalete-Barbate'] },
  ES060: { name: 'Mediterránea Andaluza', nameEn: 'Andalusian Mediterranean', ambitos: ['Cuenca Mediterránea Andaluza'] },
  ES070: { name: 'Segura', ambitos: ['Segura'] },
  ES080: { name: 'Júcar', ambitos: ['Júcar'] },
  ES091: { name: 'Ebro', ambitos: ['Ebro'] },
  ES100: { name: 'Cuencas internas de Cataluña', nameEn: 'Catalan internal basins', ambitos: ['Cuencas Internas de Cataluña'] },
  ES110: { name: 'Islas Baleares', nameEn: 'Balearic Islands', ambitos: [] }
};

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};
const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const round = (v) => Math.round(v * 1e4) / 1e4;

const proj = laea({ lat0: 40, lon0: -3 }); // equivalente: sirve para medir áreas
function areaKm2(multi) {
  let a = 0;
  for (const poly of multi) {
    poly.forEach((ring, k) => {
      let s = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const p = proj.forward(ring[i][1], ring[i][0]), q = proj.forward(ring[j][1], ring[j][0]);
        s += q.e * p.n - p.e * q.n;
      }
      a += (k === 0 ? 1 : -1) * Math.abs(s / 2);
    });
  }
  return a / 1e6;
}

const eea = await getJson(EEA);
const land = await getJson(LAND);
// Solo la tierra cerca de la península y Baleares.
const near = (multi) => multi.some((poly) => poly[0].some(([x, y]) => x > -11 && x < 6 && y > 34 && y < 45));
const landNear = land.features.map((f) => rings(f.geometry)).filter(near).flat(); // un único multipolígono

const features = [];
for (const [id, def] of Object.entries(BASINS)) {
  const f = eea.features.find((x) => x.properties.thematicIdIdentifier === id);
  if (!f) throw new Error(`Falta ${id} en la capa de la AEMA`);
  let multi = pc.intersection(rings(f.geometry), landNear);
  // Fuera islotes y restos de menos de 3 km².
  multi = multi.filter((poly) => areaKm2([[poly[0]]]) >= 3)
    .map((poly) => poly.map((ring) => ring.map(([x, y]) => [round(x), round(y)])));
  features.push({ id, name: def.name, nameEn: def.nameEn || def.name, ambitos: def.ambitos, areaKm2: Math.round(areaKm2(multi)), polygons: multi });
  console.log(id, def.name, `${Math.round(areaKm2(multi))} km²`, `${multi.length} polígonos`);
}

const out = `/*
 * Demarcaciones hidrográficas de la España peninsular y Baleares, recortadas
 * a tierra firme. Generado con scripts/agua/cuencas.mjs; no editar a mano.
 * Límites: Agencia Europea de Medio Ambiente, WISE WFD 2022 (CC BY 4.0).
 * Costa: Natural Earth (dominio público). Coordenadas [lon, lat].
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RA_CUENCAS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return ${JSON.stringify({ attribution: 'Límites: AEMA WISE (CC BY 4.0)', basins: features })};
});
`;
await fs.writeFile(path.join(ROOT, 'src/shared/cuencas.js'), out);
console.log(`src/shared/cuencas.js: ${(out.length / 1024).toFixed(0)} KB`);
