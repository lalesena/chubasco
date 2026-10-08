// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
/*
 * Mapa de ecos fijos a largo plazo (tierra, aerogeneradores, reflejos del
 * mar). Por cada píxel se cuenta con qué frecuencia tiene eco, con memoria
 * que se desvanece (vida media de 3 días). Un punto que "llueve" el 60 % del
 * tiempo, y mucho más a menudo que su entorno, no es lluvia: se ignora.
 *
 * Un mapa por caja de análisis (ubicación + radio), guardado en
 * <datos>/clutter/<clave>.bin para no empezar de cero en cada arranque.
 */
const fs = require('fs');
const path = require('path');

const HALF_LIFE_FRAMES = 432;  // 3 días de fotogramas cada 10 min
const DECAY = Math.pow(0.5, 1 / HALF_LIFE_FRAMES);
const MIN_OBS = 72;            // al menos ~12 h de datos antes de decidir
const MIN_FRACTION = 0.6;      // con eco al menos el 60 % del tiempo…
const RELATIVE = 4;            // …y 4 veces más que la media de la zona
const WET_DBZ = 10;
const KEEP_DAYS = 30;

class ClutterMap {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.obs = new Float32Array(w * h);
    this.wet = new Float32Array(w * h);
    this.lastTime = 0;
    this.cached = undefined;
    this.count = 0;
    this.dirty = false;
  }

  /** Añade un fotograma (una sola vez por hora de fotograma). */
  update(grid) {
    if (!grid || !(grid.time > this.lastTime) || grid.w !== this.w || grid.h !== this.h) return false;
    const { obs, wet } = this;
    for (let i = 0; i < obs.length; i++) {
      if (grid.kind[i] === 255) continue; // sin datos: no cuenta
      obs[i] = obs[i] * DECAY + 1;
      wet[i] = wet[i] * DECAY + (grid.dbz[i] >= WET_DBZ ? 1 : 0);
    }
    this.lastTime = grid.time;
    this.cached = undefined;
    this.dirty = true;
    return true;
  }

  /** Uint8Array (1 = eco fijo, dilatado 1 píxel) o null si no hay. */
  mask() {
    if (this.cached !== undefined) return this.cached;
    const { obs, wet, w, h } = this;
    let sObs = 0, sWet = 0;
    for (let i = 0; i < obs.length; i++) if (obs[i] >= MIN_OBS) { sObs += obs[i]; sWet += wet[i]; }
    const thr = Math.max(MIN_FRACTION, sObs ? (sWet / sObs) * RELATIVE : 1);
    const core = [];
    for (let i = 0; i < obs.length; i++) if (obs[i] >= MIN_OBS && wet[i] / obs[i] >= thr) core.push(i);
    this.count = core.length;
    if (!core.length) { this.cached = null; return null; }
    const m = new Uint8Array(w * h);
    for (const i of core) {
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) m[yy * w + xx] = 1;
        }
      }
    }
    this.cached = m;
    return m;
  }

  toBuffer() {
    const head = Buffer.alloc(16);
    head.writeUInt32LE(this.w, 0);
    head.writeUInt32LE(this.h, 4);
    head.writeDoubleLE(this.lastTime, 8);
    return Buffer.concat([head, Buffer.from(this.obs.buffer), Buffer.from(this.wet.buffer)]);
  }

  static fromBuffer(buf) {
    const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
    const n = w * h;
    if (buf.length !== 16 + n * 8) throw new Error('mapa de ecos fijos dañado');
    const m = new ClutterMap(w, h);
    m.lastTime = buf.readDoubleLE(8);
    const copy = Buffer.from(buf); // alineado para Float32Array
    m.obs = new Float32Array(copy.buffer, copy.byteOffset + 16, n).slice();
    m.wet = new Float32Array(copy.buffer, copy.byteOffset + 16 + n * 4, n).slice();
    return m;
  }
}

class ClutterStore {
  constructor(dir, { log = () => {} } = {}) {
    this.dir = path.join(dir, 'clutter');
    this.log = log;
    this.maps = new Map();
    this.timer = null;
  }

  file(key) { return path.join(this.dir, key.replace(/[^\w-]/g, '_') + '.bin'); }

  forBox(box) {
    let m = this.maps.get(box.key);
    if (m) return m;
    try {
      m = ClutterMap.fromBuffer(fs.readFileSync(this.file(box.key)));
      if (m.w !== box.w || m.h !== box.h) m = null;
    } catch (e) {
      if (e.code !== 'ENOENT') this.log('clutter', e.message);
      m = null;
    }
    m = m || new ClutterMap(box.w, box.h);
    this.maps.set(box.key, m);
    return m;
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 60000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const [key, m] of this.maps) {
        if (!m.dirty) continue;
        const f = this.file(key);
        fs.writeFileSync(f + '.tmp', m.toBuffer());
        fs.renameSync(f + '.tmp', f);
        m.dirty = false;
      }
      // Cajas que ya no se usan (ubicación movida o radio cambiado).
      const old = Date.now() - KEEP_DAYS * 86400000;
      for (const name of fs.readdirSync(this.dir)) {
        const f = path.join(this.dir, name);
        if (fs.statSync(f).mtimeMs < old) fs.unlinkSync(f);
      }
    } catch (e) {
      this.log('clutter', e.message);
    }
  }
}

module.exports = { ClutterMap, ClutterStore, MIN_OBS };
