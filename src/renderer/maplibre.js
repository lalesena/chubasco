// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/* maplibre-gl 6 solo se publica como módulo ES (sin UMD): se importa aquí y se
 * expone como global, que es lo que lee el plugin de Leaflet, cargado después
 * con defer. Con file:// (escritorio) el worker no se deduce solo. */
import * as maplibregl from '../../node_modules/maplibre-gl/dist/maplibre-gl.mjs';

window.maplibregl = maplibregl;
if (location.protocol === 'file:') {
  maplibregl.setWorkerUrl(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href);
}
