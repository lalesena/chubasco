/* Superficie de lluvia entre pluviómetros: interpolación por distancia
 * inversa (IDW) sobre una rejilla gruesa, pintada como capa de Leaflet con la
 * escala de colores que dé quien la use y recortada a tierra (las cuencas).
 * idwGrid es puro (se prueba en Node); createLayer necesita Leaflet y el DOM.
 * window.RA_SURFACE en la interfaz; module.exports = { idwGrid } en Node. */
(function () {
  'use strict';

  // ----------------------------------------------------------------
  // IDW en rejilla

  /* points: [x, y, v] en píxeles, el mismo espacio que la rejilla (el centro de
   * la celda (c, r) está en ((c + 0.5)·cell, (r + 0.5)·cell)). Devuelve el valor
   * por celda con los k puntos más cercanos dentro de radius, o NaN si no hay
   * ninguno. Un punto a menos de media celda del centro manda por sí solo. */
  function idwGrid({ points, cols, rows, cell, power = 2, radius, k = 10 }) {
    const out = new Float32Array(cols > 0 && rows > 0 ? cols * rows : 0);
    out.fill(NaN);
    if (!points || !points.length || !(radius > 0) || !out.length) return out;
    k = Math.max(1, k | 0);
    const r2 = radius * radius;
    const snap2 = (0.5 * cell) * (0.5 * cell);
    const w = cols * cell, h = rows * cell;

    // Cubos de lado radius que cubren [-radius, tamaño + radius]: fuera de ahí
    // ningún centro de celda queda a menos de radius. Con ese lado, los puntos
    // útiles de una celda están en los 3×3 cubos de alrededor.
    const bw = Math.floor((w + 2 * radius) / radius) + 1;
    const bh = Math.floor((h + 2 * radius) / radius) + 1;
    const where = new Int32Array(points.length).fill(-1);
    const start = new Int32Array(bw * bh + 1);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))) continue;
      const bx = Math.floor((p[0] + radius) / radius), by = Math.floor((p[1] + radius) / radius);
      if (bx < 0 || by < 0 || bx >= bw || by >= bh) continue;
      where[i] = by * bw + bx;
      start[where[i] + 1]++;
    }
    for (let b = 0; b < bw * bh; b++) start[b + 1] += start[b];
    const total = start[bw * bh];
    if (!total) return out;
    // Ordenados por cubo (cuenta + reparto): los 3 cubos de una fila son contiguos.
    const sx = new Float64Array(total), sy = new Float64Array(total), sv = new Float64Array(total);
    const fill = start.slice(0, bw * bh);
    for (let i = 0; i < points.length; i++) {
      if (where[i] < 0) continue;
      const j = fill[where[i]]++;
      sx[j] = points[i][0]; sy[j] = points[i][1]; sv[j] = points[i][2];
    }

    const kd = new Float64Array(k), kv = new Float64Array(k); // los k más cercanos, de menor a mayor distancia
    const half = -power / 2;
    for (let r = 0; r < rows; r++) {
      const cy = (r + 0.5) * cell;
      const by = Math.floor((cy + radius) / radius);
      const y0 = Math.max(0, by - 1), y1 = Math.min(bh - 1, by + 1);
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cell;
        const bx = Math.floor((cx + radius) / radius);
        const x0 = Math.max(0, bx - 1), x1 = Math.min(bw - 1, bx + 1);
        let m = 0;
        for (let yy = y0; yy <= y1; yy++) {
          const end = start[yy * bw + x1 + 1];
          for (let j = start[yy * bw + x0]; j < end; j++) {
            const dx = sx[j] - cx, dy = sy[j] - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            if (m < k || d2 < kd[m - 1]) {
              let s = m < k ? m++ : k - 1;
              while (s > 0 && kd[s - 1] > d2) { kd[s] = kd[s - 1]; kv[s] = kv[s - 1]; s--; }
              kd[s] = d2; kv[s] = sv[j];
            }
          }
        }
        if (!m) continue;
        if (kd[0] <= snap2) { out[r * cols + c] = kv[0]; continue; }
        let num = 0, den = 0;
        for (let s = 0; s < m; s++) {
          const wt = power === 2 ? 1 / kd[s] : Math.pow(kd[s], half);
          num += wt * kv[s]; den += wt;
        }
        out[r * cols + c] = num / den;
      }
    }
    return out;
  }

  // ----------------------------------------------------------------
  // Capa de Leaflet

  const EARTH = 40075016.686; // circunferencia (m)
  const pack = (c) => { // ImageData en little-endian, como en map.js
    if (!c) return 0;
    const q = (x) => (x < 0 ? 0 : x > 255 ? 255 : x) | 0;
    return ((q(c[3] === undefined ? 255 : c[3]) << 24) | (q(c[2]) << 16) | (q(c[1]) << 8) | q(c[0])) >>> 0;
  };

  /* opts: pane, opacity, cellPx, power, radiusKm, k, mask (polígonos de
   * RA_CUENCAS: [polígono][anillo][lon, lat]) y color (v → [r, g, b, a] o null). */
  function createLayer(L, opts) {
    const o = Object.assign({ opacity: 0.75, cellPx: 4, power: 2, radiusKm: 45, k: 10, mask: null, color: null }, opts);
    const Surface = L.Layer.extend({
      initialize(options) {
        L.setOptions(this, options);
        this._pts = [];
        this._color = typeof o.color === 'function' ? o.color : null;
        this._lut = new Map(); // valor redondeado a 0.1 → color empaquetado
        this._rings = null; // máscara proyectada (a zoom 0), la primera vez que se dibuja
        this._buf = null; this._raf = 0; this._canvas = null;
      },

      getEvents() {
        return { zoomstart: this._hide, moveend: this._schedule, zoomend: this._schedule, resize: this._schedule };
      },

      onAdd(map) {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        canvas.style.opacity = String(o.opacity);
        (this.getPane() || map.getPane('overlayPane')).appendChild(canvas);
        this._canvas = canvas;
        this._rings = null;
        this._draw();
      },

      onRemove() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
        if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
        this._canvas = null; this._buf = null;
      },

      // list: [{ lat, lon, v }]; lo que no sean números finitos se ignora.
      setPoints(list) {
        this._pts = (list || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.v));
        return this.redraw();
      },

      setColor(fn) {
        this._color = typeof fn === 'function' ? fn : null;
        this._lut = new Map();
        return this.redraw();
      },

      setOpacity(v) {
        o.opacity = v;
        if (this._canvas) this._canvas.style.opacity = String(v);
        return this;
      },

      redraw() {
        if (this._map) this._draw();
        return this;
      },

      _hide() { if (this._canvas) this._canvas.style.visibility = 'hidden'; },
      // moveend y zoomend llegan juntos al hacer zoom: un solo dibujo por fotograma.
      _schedule() {
        if (this._raf || !this._map) return;
        this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
      },

      // Color empaquetado de un valor; la escala se consulta una vez por cada 0.1.
      _pack(v) {
        const key = Math.round(v * 10);
        let p = this._lut.get(key);
        if (p === undefined) { p = pack(this._color(key / 10)); this._lut.set(key, p); }
        return p;
      },

      // Anillos de la máscara en píxeles de mundo a zoom 0 (escalan con 2^zoom).
      _project(map) {
        const crs = map.options.crs;
        const rings = [];
        for (const poly of o.mask || []) {
          for (const ring of poly) {
            const a = new Float64Array(ring.length * 2);
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (let i = 0; i < ring.length; i++) {
              const p = crs.latLngToPoint(L.latLng(ring[i][1], ring[i][0]), 0);
              a[2 * i] = p.x; a[2 * i + 1] = p.y;
              if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
              if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
            }
            rings.push({ a, minx, miny, maxx, maxy });
          }
        }
        return rings;
      },

      _draw() {
        const map = this._map, canvas = this._canvas;
        if (!map || !canvas) return;
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
        const size = map.getSize();
        const W = size.x, H = size.y;
        const dpr = window.devicePixelRatio || 1;
        const pw = Math.max(0, Math.round(W * dpr)), ph = Math.max(0, Math.round(H * dpr));
        if (canvas.width !== pw) canvas.width = pw;
        if (canvas.height !== ph) canvas.height = ph;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        canvas.style.visibility = '';
        L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pw, ph);
        if (!pw || !ph || !this._color || !this._pts.length) return;

        // Radio en píxeles: metros por píxel a la latitud del centro y el zoom actual.
        const mpp = EARTH * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
        const radius = (o.radiusKm * 1000) / mpp;
        const cell = o.cellPx;
        const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);

        // Los puntos de poco más allá del borde cuentan: así la superficie no se corta.
        const pts = [];
        for (const p of this._pts) {
          const c = map.latLngToContainerPoint([p.lat, p.lon]);
          if (c.x < -radius || c.x > W + radius || c.y < -radius || c.y > H + radius) continue;
          pts.push([c.x, c.y, p.v]);
        }
        if (!pts.length) return;
        const grid = idwGrid({ points: pts, cols, rows, cell, power: o.power, radius, k: o.k });

        let off = this._buf;
        if (!off || off.canvas.width !== cols || off.canvas.height !== rows) {
          const oc = document.createElement('canvas');
          oc.width = cols; oc.height = rows;
          const octx = oc.getContext('2d');
          const img = octx.createImageData(cols, rows);
          off = this._buf = { canvas: oc, ctx: octx, img, px: new Uint32Array(img.data.buffer) };
        }
        const px = off.px;
        for (let i = 0; i < grid.length; i++) { const v = grid[i]; px[i] = v === v ? this._pack(v) : 0; }
        off.ctx.putImageData(off.img, 0, 0);

        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off.canvas, 0, 0, cols, rows, 0, 0, cols * cell * (pw / W), rows * cell * (ph / H));
        if (o.mask && o.mask.length) this._clip(ctx, map, W, H, pw / W, ph / H);
      },

      // Deja solo lo que cae dentro de la máscara (todos los anillos, par-impar).
      _clip(ctx, map, W, H, sx, sy) {
        if (!this._rings) this._rings = this._project(map);
        const zs = map.getZoomScale(map.getZoom(), 0);
        const org = map.getPixelBounds().min; // píxel de mundo de la esquina del mapa
        ctx.setTransform(sx, 0, 0, sy, 0, 0);
        ctx.beginPath();
        let any = false;
        for (const ring of this._rings) {
          if (ring.maxx * zs - org.x < 0 || ring.minx * zs - org.x > W || ring.maxy * zs - org.y < 0 || ring.miny * zs - org.y > H) continue;
          const a = ring.a;
          let lx = 0, ly = 0;
          for (let i = 0; i < a.length; i += 2) {
            const x = a[i] * zs - org.x, y = a[i + 1] * zs - org.y;
            if (i === 0) ctx.moveTo(x, y);
            else if (Math.abs(x - lx) + Math.abs(y - ly) < 0.5) continue; // vértices casi juntos
            else ctx.lineTo(x, y);
            lx = x; ly = y;
          }
          ctx.closePath();
          any = true;
        }
        if (any) {
          ctx.globalCompositeOperation = 'destination-in';
          ctx.fillStyle = '#000';
          ctx.fill('evenodd');
          ctx.globalCompositeOperation = 'source-over';
        } else {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); // el mapa no ve nada de la máscara
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    });
    return new Surface(o.pane ? { pane: o.pane } : {});
  }

  if (typeof window !== 'undefined') window.RA_SURFACE = { idwGrid, createLayer };
  if (typeof module === 'object' && module.exports) module.exports = { idwGrid };
})();
