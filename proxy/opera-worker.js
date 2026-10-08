// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/*
 * Intermediario para leer el radar EUMETNET OPERA desde la web de Chubasco.
 *
 * El almacén abierto de EUMETNET no admite peticiones desde otras webs
 * (no envía cabeceras CORS). Este Worker de Cloudflare reenvía solo los
 * ficheros del compuesto europeo, trozo a trozo (cabecera HTTP Range), les
 * añade CORS y guarda cada trozo en la caché de Cloudflare: los ficheros no
 * cambian una vez publicados, así que cada trozo se pide al origen una vez
 * por centro de datos.
 *
 * Solo atiende a las webs de ALLOWED_ORIGINS (variable del Worker, separadas
 * por comas; por defecto, la web de Chubasco) y a localhost para pruebas: así
 * otras webs, o copias de este repositorio, no gastan su cuota. Cada copia
 * debe desplegar su propio Worker.
 *
 * Despliegue: ver README (sección «Radar OPERA en la web»).
 */
const UPSTREAM = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
const PATH = /^\/(\d{4})\/(\d{2})\/(\d{2})\/OPERA\/COMP\/OPERA@(\d{8})T(\d{4})@0@DBZH\.tiff$/;
const RANGE = /^bytes=(\d{1,9})-(\d{1,9})$/;
const MAX_BYTES = 4 << 20;
const DEFAULT_ORIGINS = 'https://lalesena.github.io';
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const CORS = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range',
  'Access-Control-Max-Age': '86400'
};

// El origen de la petición, si está permitido (los navegadores siempre lo envían en peticiones entre webs).
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = String((env && env.ALLOWED_ORIGINS) || DEFAULT_ORIGINS).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.includes(origin) || LOCAL.test(origin) ? origin : null;
}

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request, env);
    const cors = origin ? { ...CORS, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const reply = (text, status, extra = {}) => new Response(text, { status, headers: { ...cors, 'Cache-Control': 'no-store', ...extra } });
    if (!origin) return reply('Origen no permitido', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return reply('Método no admitido', 405);
    const url = new URL(request.url);
    const m = PATH.exec(url.pathname);
    if (!m || m[4] !== m[1] + m[2] + m[3]) return reply('No encontrado', 404);
    const r = RANGE.exec(request.headers.get('Range') || '');
    const start = r ? Number(r[1]) : -1, end = r ? Number(r[2]) : -1;
    if (!r || end < start || end - start + 1 > MAX_BYTES) return reply('Hace falta un rango de bytes', 416);

    // La caché no guarda respuestas 206: cada trozo va como 200 con su rango en la clave.
    const cache = caches.default;
    const key = new Request(`${url.origin}${url.pathname}?bytes=${start}-${end}`);
    let hit = await cache.match(key);
    if (!hit) {
      const up = await fetch(UPSTREAM + url.pathname, { headers: { Range: `bytes=${start}-${end}` } });
      if (up.status === 404 || up.status === 403) return reply('Aún no publicado', 404);
      if (up.status !== 206 && up.status !== 200) return reply('Error del origen', 502);
      let body, total = '*';
      if (up.status === 206) {
        body = await up.arrayBuffer();
        total = (up.headers.get('Content-Range') || '').split('/')[1] || '*';
      } else {
        // El origen ignoró el rango y mandó el fichero entero.
        const all = new Uint8Array(await up.arrayBuffer());
        body = all.slice(start, end + 1).buffer;
        total = String(all.length);
      }
      hit = new Response(body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400, immutable',
          'X-Content-Range': `bytes ${start}-${start + body.byteLength - 1}/${total}`
        }
      });
      ctx.waitUntil(cache.put(key, hit.clone()));
    }
    return new Response(hit.body, {
      status: 206,
      headers: {
        ...cors,
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400, immutable',
        'Content-Range': hit.headers.get('X-Content-Range')
      }
    });
  }
};
