'use strict';
/*
 * Actualizaciones desde las versiones publicadas en GitHub (build.publish de
 * package.json).
 *  - Windows: electron-updater descarga la nueva versión y la instala al
 *    cerrar la app.
 *  - macOS: sin un certificado "Developer ID" de Apple la instalación
 *    automática no es fiable, así que se avisa y se abre la página de descarga.
 * Mientras el dueño del repositorio sea el provisional, no se comprueba nada.
 */
const OWNER_PLACEHOLDER = 'TU_USUARIO';
const FIRST_CHECK_MS = 60 * 1000;
const EVERY_MS = 6 * 3600 * 1000;

function repoInfo(pkg) {
  const pubs = pkg && pkg.build && pkg.build.publish;
  const pub = Array.isArray(pubs) ? pubs.find((p) => p.provider === 'github') : pubs;
  let info = pub && pub.provider === 'github' && pub.owner && pub.repo ? { owner: pub.owner, repo: pub.repo } : null;
  // En la app empaquetada electron-builder quita "build": queda repository.url.
  if (!info) {
    const url = pkg && pkg.repository && (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url);
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(String(url || ''));
    if (m) info = { owner: m[1], repo: m[2] };
  }
  return info && info.owner !== OWNER_PLACEHOLDER ? info : null;
}

/** ¿Es `a` más nueva que `b`? (versiones x.y.z, admite "v" delante) */
function isNewer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

class Updater {
  constructor({ app, pkg, fetch, log = () => {}, onAvailable = () => {} }) {
    this.app = app;
    this.repo = repoInfo(pkg);
    this.fetch = fetch;
    this.log = log;
    this.onAvailable = onAvailable;
    this.available = null; // { version, url, ready }
    this.timer = null;
    this.auto = null;
  }

  get enabled() { return !!(this.app.isPackaged && this.repo); }

  start() {
    if (!this.enabled) return;
    if (process.platform === 'win32') {
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = { info: () => {}, warn: (m) => this.log('update', m), error: (m) => this.log('update', m), debug: () => {} };
        autoUpdater.on('update-downloaded', (info) => this.found({ version: info.version, ready: true }));
        autoUpdater.on('error', (e) => this.log('update', e && e.message));
        this.auto = autoUpdater;
      } catch (e) {
        this.log('update', e.message);
      }
    }
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check(), EVERY_MS);
  }

  async check() {
    if (!this.enabled) return null;
    try {
      if (this.auto) { await this.auto.checkForUpdates(); return this.available; }
      const { owner, repo } = this.repo;
      const res = await this.fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Chubasco/${this.app.getVersion()}` }
      });
      if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
      const rel = await res.json();
      if (rel && rel.tag_name && isNewer(rel.tag_name, this.app.getVersion())) {
        this.found({ version: rel.tag_name.replace(/^v/, ''), url: rel.html_url, ready: false });
      }
    } catch (e) {
      this.log('update', e.message);
    }
    return this.available;
  }

  found(info) {
    if (this.available && this.available.version === info.version && this.available.ready === info.ready) return;
    this.available = info;
    this.onAvailable(info);
  }

  /** Windows: reinicia e instala ya la versión descargada. */
  installNow() {
    if (this.auto && this.available && this.available.ready) this.auto.quitAndInstall();
  }
}

module.exports = { Updater, repoInfo, isNewer, OWNER_PLACEHOLDER };
