/*
 * Construye la versión web en web/dist (una web estática: GitHub Pages o
 * cualquier alojamiento). Reutiliza la interfaz de la app tal cual:
 *  - index.html  ← src/renderer/index.html (la app completa)
 *  - embed.html  ← src/renderer/widget.html (el widget para otras webs)
 *  - engine.js   ← web/src/engine.js + los módulos de análisis de la app
 * Uso: npm run build:web
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'dist');
const NM = path.join(ROOT, 'node_modules');
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

// Intermediario de OPERA (proxy/opera-worker.js en Cloudflare): package.json →
// config.operaProxy. Sin él, la web sigue con RainViewer.
const OPERA_PROXY = String((pkg.config && pkg.config.operaProxy) || process.env.CHUBASCO_OPERA_PROXY || '').replace(/\/+$/, '');
if (OPERA_PROXY && !/^(https:\/\/[\w.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[\w./-]*)?$/.test(OPERA_PROXY)) {
  throw new Error('config.operaProxy no es una dirección https válida');
}
const RADAR_HOSTS = OPERA_PROXY ? [new URL(OPERA_PROXY).origin] : ['https://api.rainviewer.com', 'https://tilecache.rainviewer.com'];
const DATA_HOSTS = [
  ...RADAR_HOSTS,
  'https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com',
  'https://nominatim.openstreetmap.org', 'https://view.eumetsat.int'
].join(' ');
const RADAR_IMG = OPERA_PROXY ? '' : ' https://*.rainviewer.com';
const CSP = {
  app: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
    `img-src 'self' data: blob:${RADAR_IMG}; connect-src 'self' https://tiles.openfreemap.org ${DATA_HOSTS}; ` +
    "worker-src 'self' blob:; child-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
  embed: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; " +
    `connect-src 'self' ${DATA_HOSTS}; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`
};

const copy = async (from, to) => {
  await fs.mkdir(path.dirname(path.join(OUT, to)), { recursive: true });
  await fs.cp(from, path.join(OUT, to), { recursive: true });
};
const write = async (to, text) => {
  await fs.mkdir(path.dirname(path.join(OUT, to)), { recursive: true });
  await fs.writeFile(path.join(OUT, to), text);
};

// Las rutas de la app (node_modules, ../shared…) pasan a las de la web.
function rewrite(html, csp) {
  const out = html
    .replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replaceAll('../../node_modules/@fontsource-variable/archivo/', 'vendor/archivo/')
    .replaceAll('../../node_modules/leaflet/dist/', 'vendor/leaflet/')
    .replaceAll('../../node_modules/maplibre-gl/dist/', 'vendor/maplibre/')
    .replaceAll('../../node_modules/@maplibre/maplibre-gl-leaflet/', 'vendor/maplibre/')
    .replace(/<script src="\.\.\/shared\/([\w-]+\.js)"><\/script>/g, '<script src="js/$1"></script>')
    .replace(/<script src="([\w-]+\.js)"><\/script>/g, '<script src="js/$1"></script>');
  if (out.includes('../') || !out.includes(csp)) throw new Error('Quedan rutas de la app sin adaptar');
  return out;
}

function releasesUrl() {
  const pub = [].concat(pkg.build.publish || []).find((p) => p.provider === 'github');
  return pub && pub.owner !== 'TU_USUARIO' ? `https://github.com/${pub.owner}/${pub.repo}/releases/latest` : null;
}

await fs.rm(OUT, { recursive: true, force: true });

// 1. Motor (Web Worker): los módulos de análisis de la app, empaquetados.
//    fs y path solo los usan las partes de escritorio que la web no llama.
await build({
  entryPoints: [path.join(ROOT, 'web', 'src', 'engine.js')],
  outfile: path.join(OUT, 'engine.js'),
  bundle: true, format: 'iife', platform: 'browser', target: ['es2022'], minify: true, legalComments: 'none',
  plugins: [{
    name: 'sin-node',
    setup(b) {
      b.onResolve({ filter: /^(fs|path)$/ }, (a) => ({ path: a.path, namespace: 'sin-node' }));
      b.onLoad({ filter: /.*/, namespace: 'sin-node' }, () => ({ contents: 'module.exports = {};' }));
    }
  }]
});

// 2. Librerías, tipografía y código de la interfaz.
await copy(path.join(NM, 'leaflet/dist/leaflet.js'), 'vendor/leaflet/leaflet.js');
await copy(path.join(NM, 'leaflet/dist/leaflet.css'), 'vendor/leaflet/leaflet.css');
await copy(path.join(NM, 'leaflet/dist/images'), 'vendor/leaflet/images');
await copy(path.join(NM, 'leaflet/LICENSE'), 'vendor/leaflet/LICENSE');
await copy(path.join(NM, 'maplibre-gl/dist/maplibre-gl.js'), 'vendor/maplibre/maplibre-gl.js');
await copy(path.join(NM, 'maplibre-gl/dist/maplibre-gl.css'), 'vendor/maplibre/maplibre-gl.css');
await copy(path.join(NM, 'maplibre-gl/LICENSE.txt'), 'vendor/maplibre/LICENSE.txt');
await copy(path.join(NM, '@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js'), 'vendor/maplibre/leaflet-maplibre-gl.js');
await copy(path.join(NM, '@maplibre/maplibre-gl-leaflet/LICENSE'), 'vendor/maplibre/LICENSE-leaflet-maplibre-gl');
const fontCss = await fs.readFile(path.join(NM, '@fontsource-variable/archivo/wdth.css'), 'utf8');
await write('vendor/archivo/wdth.css', fontCss);
for (const [, file] of fontCss.matchAll(/url\(\.\/files\/([\w.-]+)\)/g)) {
  await copy(path.join(NM, '@fontsource-variable/archivo/files', file), `vendor/archivo/files/${file}`);
}
await copy(path.join(NM, '@fontsource-variable/archivo/LICENSE'), 'vendor/archivo/LICENSE');
for (const f of ['palette', 'i18n', 'forecast', 'describe']) await copy(path.join(ROOT, `src/shared/${f}.js`), `js/${f}.js`);
for (const f of ['charts', 'map', 'app', 'widget']) await copy(path.join(ROOT, `src/renderer/${f}.js`), `js/${f}.js`);
await copy(path.join(ROOT, 'src/renderer/styles.css'), 'styles.css');
await copy(path.join(ROOT, 'web/src/client.js'), 'client.js');
await copy(path.join(ROOT, 'web/src/web-ui.js'), 'js/web-ui.js');
await write('config.js', `window.CHUBASCO_WEB = ${JSON.stringify({ version: pkg.version, releases: releasesUrl(), operaProxy: OPERA_PROXY || null })};\n`);
console.log(OPERA_PROXY ? `Radar: OPERA a través de ${OPERA_PROXY}` : 'Radar: RainViewer (falta config.operaProxy en package.json)');

// 3. Páginas.
const HEAD = `<meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Radar de lluvia en tiempo real, previsión para las próximas 2 horas y avisos cuando se acerca la lluvia.">
  <meta name="theme-color" content="#0077aa">
  <link rel="icon" href="icon-192.png">
  <link rel="apple-touch-icon" href="icon-192.png">
  <link rel="manifest" href="manifest.webmanifest">
  <title>Chubasco</title>`;
const app = rewrite(await fs.readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8'), CSP.app)
  .replace('<title>Chubasco</title>', HEAD)
  .replace('<script src="vendor/leaflet/leaflet.js"></script>', '<script src="config.js"></script>\n  <script src="client.js"></script>\n  <script src="vendor/leaflet/leaflet.js"></script>')
  .replace('<script src="js/app.js"></script>', '<script src="js/app.js"></script>\n  <script src="js/web-ui.js"></script>');
await write('index.html', app);

const embed = rewrite(await fs.readFile(path.join(ROOT, 'src/renderer/widget.html'), 'utf8'), CSP.embed)
  .replace('<html lang="es">', '<html lang="es" data-mode="embed">')
  .replace('<script src="js/palette.js"></script>', '<script src="config.js"></script>\n  <script src="client.js"></script>\n  <script src="js/palette.js"></script>');
await write('embed.html', embed);

// 4. Páginas y ficheros fijos (privacidad, manifiesto, iconos).
await fs.cp(path.join(ROOT, 'web', 'static'), OUT, { recursive: true });
// Aviso de privacidad: solo la fuente de radar que se usa.
const privacy = path.join(OUT, 'privacidad.html');
const drop = OPERA_PROXY ? 'rainviewer' : 'opera';
await fs.writeFile(privacy, (await fs.readFile(privacy, 'utf8')).replace(new RegExp(`\\n *<li data-radar="${drop}">.*</li>`, 'g'), '').replace(/ data-radar="\w+"/g, ''));
await copy(path.join(ROOT, 'assets/icon-512.png'), 'icon-512.png');
await write('.nojekyll', '');

const files = await fs.readdir(OUT, { recursive: true });
console.log(`web/dist: ${files.length} ficheros`);
