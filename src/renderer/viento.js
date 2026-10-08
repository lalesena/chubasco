// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/* Modo «Viento»: el viento de un modelo (ECMWF, ICON-EU o GFS) sobre el mapa,
 * con partículas que lo siguen y el fondo coloreado por la velocidad (o por
 * las rachas), una línea de tiempo y, en el panel, el viento en la ubicación
 * activa o en el punto que se pinche, con la gráfica de las próximas horas.
 * Los datos los publica la web cada hora (scripts/viento/datos.mjs; formato
 * en src/shared/windgrid.js). */
(function () {
  'use strict';
  const L = window.L;
  const WG = window.RA_WINDGRID;
  const D = window.RA_DESCRIBE;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const HOUR = 3600000;
  const TRAIL = 16;         // posiciones que recuerda cada partícula (la estela)
  const CELL = 4;           // px de la rejilla del viento en pantalla
  const PX_PER_MS = 0.15;   // px por fotograma por cada m/s
  const PLAY_MS = 700;
  const MAX_ZOOM = 7;       // al entrar: más cerca, la rejilla de 25 km se ve a manchas
  const LEGEND_MAX = 35;    // m/s al final de la leyenda
  const CC_BY = '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';
  // Atribución en el mapa de cada modelo (ECMWF y el DWD piden la licencia y avisar de que los datos están procesados).
  const ATTR = {
    ecmwf: (t) => `Viento <a href="https://www.ecmwf.int/">ECMWF</a> IFS (${CC_BY}, ${t('map.processed')})`,
    'icon-eu': (t) => `Viento ICON-EU © <a href="https://www.dwd.de/">DWD</a> (${CC_BY}, ${t('map.processed')})`,
    gfs: () => 'Viento <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast">GFS</a> (NOAA)'
  };
  const MODEL_KEY = 'chubasco.viento.modelo';
  function savedModel() {
    try { const m = localStorage.getItem(MODEL_KEY); if (WG.MODELS.some((x) => x.id === m)) return m; } catch (e) { /* almacenamiento bloqueado */ }
    return WG.MODELS[0].id;
  }
  // Flecha hacia abajo: girada `from` grados apunta hacia donde va el viento.
  const ARROW = '<svg class="vt-arrow" viewBox="0 0 16 16" aria-hidden="true" style="transform:rotate({deg}deg)"><path d="M8 2v11M3.8 8.8 8 13l4.2-4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const arrow = (from) => ARROW.replace('{deg}', Math.round(from));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function create({ map, api, dom, getT, getUnits, getPlace, setAttribution = () => {} }) {
    const st = {
      open: false, index: null, indexAt: 0, error: null, gen: 0,
      steps: [], data: new Map(), loading: new Map(),
      cur: 0, playing: false, timer: null, refresher: null,
      model: savedModel(), field: 'speed', particles: true,
      point: null, placeKey: null, prevView: null, hover: null, marker: null
    };
    const t = (k, v) => getT()(k, v);
    const locale = () => (getT().lang === 'es' ? 'es-ES' : 'en-GB');
    const units = () => getUnits() || {};
    const mph = () => units().distance === 'mi';
    const val = (ms) => (mph() ? ms * 2.236936 : ms * 3.6);
    const unit = () => (mph() ? 'mph' : 'km/h');
    const speed = (ms) => D.fmtSpeed(getT(), ms * 3.6, units());
    const clock = (ts) => D.fmtClock(getT(), ts);
    const weekday = (ts, style = 'short') => new Intl.DateTimeFormat(locale(), { weekday: style }).format(new Date(ts));
    const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
    const when = (ts) => {
      const now = Date.now();
      if (sameDay(ts, now) || sameDay(ts, now + 24 * HOUR)) return D.fmtWhen(getT(), ts);
      return `${t('viento.on', { day: weekday(ts, 'long') })} ${t('time.at', { time: clock(ts) })}`;
    };

    map.createPane('vientocolor').style.zIndex = 320;
    const partPane = map.createPane('vientoparticles');
    partPane.style.zIndex = 350;
    partPane.style.pointerEvents = 'none';

    const step = (i = st.cur) => st.steps[i] || null;
    const dataOf = (i = st.cur) => { const s = step(i); return s ? st.data.get(s.f) || null : null; };

    // ----------------------------------------------------------------
    // Datos: el índice y cada hora, a demanda (primero la que se ve y luego
    // las de alrededor, para la animación y la gráfica).

    async function loadIndex(force) {
      if (!force && st.index && Date.now() - st.indexAt < 10 * 60000) { pickSteps(); return; }
      try {
        const model = st.model;
        const idx = await api.viento(`${model}/index.json`);
        if (model !== st.model) return; // se cambió de modelo mientras tanto
        if (!idx || idx.v !== 1 || idx.model !== model || !idx.grid || !Array.isArray(idx.steps) || !idx.steps.length) throw new Error('índice de viento no válido');
        if (!st.index || st.index.run !== idx.run) { st.data.clear(); st.loading.clear(); st.gen++; }
        st.index = idx;
        st.indexAt = Date.now();
        st.error = null;
      } catch (e) {
        console.warn('viento', e);
        if (!st.index) st.error = e;
      }
      if (st.index) pickSteps();
    }

    // Desde la hora en curso (la última que ya ha empezado) hasta el final de la
    // pasada, y en la hora más cercana a la que se veía (otro modelo puede ir cada 3 h).
    function pickSteps(keep = step() && step().t) {
      const all = st.index.steps;
      const now = Date.now();
      let first = 0;
      for (let i = 0; i < all.length; i++) if (all[i].t <= now) first = i;
      st.steps = all.slice(first);
      st.cur = 0;
      if (keep) st.steps.forEach((s, i) => { if (Math.abs(s.t - keep) < Math.abs(st.steps[st.cur].t - keep)) st.cur = i; });
    }

    function loadStep(s) {
      if (st.data.has(s.f)) return Promise.resolve(st.data.get(s.f));
      if (!st.loading.has(s.f)) {
        const gen = st.gen, grid = st.index.grid, scale = st.index.scale, model = st.model;
        const p = (async () => {
          const raw = await WG.inflate(await api.viento(`${model}/${s.f}`));
          const d = WG.decode(raw, grid, scale);
          if (gen === st.gen) st.data.set(s.f, d);
          return d;
        })();
        st.loading.set(s.f, p);
        p.then(() => { if (st.loading.get(s.f) === p) st.loading.delete(s.f); },
          () => { if (st.loading.get(s.f) === p) st.loading.delete(s.f); });
      }
      return st.loading.get(s.f);
    }

    let failures = 0;
    function prefetch() {
      const gen = st.gen;
      const order = st.steps.map((_, i) => i).sort((a, b) => Math.abs(a - st.cur) - Math.abs(b - st.cur) || a - b);
      let active = 0;
      const next = () => {
        while (st.open && gen === st.gen && active < 3 && order.length) {
          const s = st.steps[order.shift()];
          if (!s || st.data.has(s.f)) continue;
          active++;
          loadStep(s).then(() => { failures = 0; loaded(s); }, (e) => {
            console.warn('viento', s.f, e);
            // Una pasada nueva borra la anterior de la web: se vuelve a leer el índice.
            if (++failures === 3 && gen === st.gen) loadIndex(true).then(() => { if (gen !== st.gen) { render(); prefetch(); } });
          }).finally(() => { active--; next(); });
        }
      };
      next();
    }

    let renderSoon = null;
    function loaded(s) {
      if (!st.open) return;
      if (step() === s) applyStep();
      else {
        renderTimeline();
        clearTimeout(renderSoon);
        renderSoon = setTimeout(render, 250); // la gráfica se completa según llegan las horas
      }
    }

    // ----------------------------------------------------------------
    // Fondo coloreado: teselas que se pintan píxel a píxel (Mercator → rejilla)

    const LUT = WG.colorTable();
    function paintTile(tile) {
      const ctx = tile.getContext('2d');
      const d = dataOf();
      const w = tile.width, h = tile.height;
      if (!d || !st.index) { ctx.clearRect(0, 0, w, h); return; }
      const g = st.index.grid;
      const arr = st.field === 'gust' ? d.gust : d.speed;
      const { x: tx, y: ty, z } = tile._vc;
      const world = w * 2 ** z;
      const img = ctx.createImageData(w, h);
      const px = new Uint32Array(img.data.buffer);
      const c0s = new Int32Array(w), fcs = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const lon = ((((tx * w + x + 0.5) / world) * 360) % 360 + 360) % 360 - 180;
        const c = (lon - g.west) / g.step;
        if (!(c >= 0 && c <= g.cols - 1)) { c0s[x] = -1; continue; }
        c0s[x] = Math.min(g.cols - 2, Math.floor(c));
        fcs[x] = c - c0s[x];
      }
      const top = LUT.length - 1, inv = 1 / WG.LUT_STEP;
      for (let y = 0; y < h; y++) {
        const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty * h + y + 0.5)) / world))) * 180 / Math.PI;
        const r = (g.north - lat) / g.step;
        if (!(r >= 0 && r <= g.rows - 1)) continue;
        const r0 = Math.min(g.rows - 2, Math.floor(r)), fr = r - r0;
        const row = r0 * g.cols, o = y * w;
        for (let x = 0; x < w; x++) {
          const c0 = c0s[x];
          if (c0 < 0) continue;
          const fc = fcs[x], i = row + c0;
          const v = (arr[i] * (1 - fc) + arr[i + 1] * fc) * (1 - fr) + (arr[i + g.cols] * (1 - fc) + arr[i + g.cols + 1] * fc) * fr;
          px[o + x] = LUT[Math.min(top, (v * inv) | 0)];
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    const ColorLayer = L.GridLayer.extend({
      createTile(coords) {
        const tile = L.DomUtil.create('canvas', 'leaflet-tile');
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        tile._vc = coords;
        paintTile(tile);
        return tile;
      }
    });
    const colorLayer = new ColorLayer({ pane: 'vientocolor', opacity: 0.72, keepBuffer: 1, updateWhenZooming: false });
    function repaintColor() { for (const k in colorLayer._tiles) paintTile(colorLayer._tiles[k].el); }

    // ----------------------------------------------------------------
    // Partículas: cada una avanza con el viento del sitio donde está y deja
    // una estela con sus últimas posiciones. El viento se precalcula en una
    // rejilla de pantalla (cada CELL px) al moverse el mapa o cambiar la hora.

    const P = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1, fu: null, fv: null, fc: 0, fr: 0, n: 0, raf: 0, moving: false };
    let vx = 0, vy = 0;

    function setupCanvas() {
      if (!P.canvas) {
        P.canvas = L.DomUtil.create('canvas', 'viento-particles', partPane);
        P.ctx = P.canvas.getContext('2d');
      }
      const size = map.getSize();
      P.dpr = window.devicePixelRatio || 1;
      P.w = size.x;
      P.h = size.y;
      P.canvas.width = Math.round(size.x * P.dpr);
      P.canvas.height = Math.round(size.y * P.dpr);
      P.canvas.style.width = `${size.x}px`;
      P.canvas.style.height = `${size.y}px`;
      L.DomUtil.setPosition(P.canvas, map.containerPointToLayerPoint([0, 0]));
    }

    function buildField() {
      P.fc = Math.ceil(P.w / CELL) + 2;
      P.fr = Math.ceil(P.h / CELL) + 2;
      P.fu = new Float32Array(P.fc * P.fr).fill(NaN);
      P.fv = new Float32Array(P.fc * P.fr).fill(NaN);
      const d = dataOf();
      if (!d || !P.w) return;
      const g = st.index.grid;
      // En Mercator la longitud solo depende de x y la latitud solo de y.
      const cs = new Float32Array(P.fc), rs = new Float32Array(P.fr);
      for (let c = 0; c < P.fc; c++) {
        const lon = ((map.containerPointToLatLng([c * CELL, 0]).lng + 540) % 360) - 180;
        const gc = (lon - g.west) / g.step;
        cs[c] = gc >= 0 && gc <= g.cols - 1 ? gc : -1;
      }
      for (let r = 0; r < P.fr; r++) {
        const gr = (g.north - map.containerPointToLatLng([0, r * CELL]).lat) / g.step;
        rs[r] = gr >= 0 && gr <= g.rows - 1 ? gr : -1;
      }
      for (let r = 0; r < P.fr; r++) {
        if (rs[r] < 0) continue;
        for (let c = 0; c < P.fc; c++) {
          if (cs[c] < 0) continue;
          P.fu[r * P.fc + c] = WG.bilinear(d.u, g, cs[c], rs[r]);
          P.fv[r * P.fc + c] = WG.bilinear(d.v, g, cs[c], rs[r]);
        }
      }
    }

    // Viento (m/s) en un punto de la pantalla, en vx y vy; false si no hay datos.
    function windAt(x, y) {
      const fx = x / CELL, fy = y / CELL;
      const c0 = fx | 0, r0 = fy | 0;
      if (x < 0 || y < 0 || c0 >= P.fc - 1 || r0 >= P.fr - 1) return false;
      const a = fx - c0, b = fy - r0, i = r0 * P.fc + c0;
      const u = (P.fu[i] * (1 - a) + P.fu[i + 1] * a) * (1 - b) + (P.fu[i + P.fc] * (1 - a) + P.fu[i + P.fc + 1] * a) * b;
      const v = (P.fv[i] * (1 - a) + P.fv[i + 1] * a) * (1 - b) + (P.fv[i + P.fc] * (1 - a) + P.fv[i + P.fc + 1] * a) * b;
      if (u !== u || v !== v) return false; // NaN: fuera de la rejilla
      vx = u; vy = v;
      return true;
    }

    function seed() {
      P.n = Math.min(7000, Math.round((P.w * P.h) / 380));
      P.hx = new Float32Array(P.n * TRAIL);
      P.hy = new Float32Array(P.n * TRAIL);
      P.len = new Uint8Array(P.n);
      P.age = new Uint16Array(P.n);
      P.max = new Uint16Array(P.n);
      P.drain = new Uint8Array(P.n);
      for (let i = 0; i < P.n; i++) spawn(i, true);
    }

    function spawn(i, scatter) {
      let x = -1, y = -1;
      for (let k = 0; k < 12; k++) {
        const tx = Math.random() * P.w, ty = Math.random() * P.h;
        if (windAt(tx, ty)) { x = tx; y = ty; break; }
      }
      P.hx[i * TRAIL] = x;
      P.hy[i * TRAIL] = y;
      P.len[i] = x < 0 ? 0 : 1;
      P.max[i] = 50 + Math.random() * 70;
      P.age[i] = scatter ? Math.random() * P.max[i] : 0; // al empezar, de edades distintas: no mueren todas a la vez
      P.drain[i] = 0;
    }

    function stepParticles() {
      const K = PX_PER_MS;
      for (let i = 0; i < P.n; i++) {
        const b = i * TRAIL;
        if (!P.len[i]) { spawn(i, false); continue; }
        let x = P.hx[b], y = P.hy[b];
        let alive = !P.drain[i] && P.age[i] < P.max[i] && windAt(x, y);
        if (alive) {
          x += vx * K;
          y -= vy * K;
          if (x < 0 || y < 0 || x >= P.w || y >= P.h) alive = false;
        }
        if (!alive) {
          // Se queda quieta y la estela se recoge sola; luego renace en otro sitio.
          x = P.hx[b]; y = P.hy[b];
          if (++P.drain[i] >= TRAIL) { spawn(i, false); continue; }
        }
        P.age[i]++;
        for (let k = TRAIL - 1; k > 0; k--) { P.hx[b + k] = P.hx[b + k - 1]; P.hy[b + k] = P.hy[b + k - 1]; }
        P.hx[b] = x;
        P.hy[b] = y;
        if (P.len[i] < TRAIL) P.len[i]++;
      }
    }

    function draw() {
      const ctx = P.ctx;
      ctx.setTransform(P.dpr, 0, 0, P.dpr, 0, 0);
      ctx.clearRect(0, 0, P.w, P.h);
      ctx.lineWidth = 1.15;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#fff';
      // Un trazo por tramo de estela (del más nuevo al más viejo), cada vez más tenue.
      for (let j = 0; j < TRAIL - 1; j++) {
        ctx.globalAlpha = 0.9 * (1 - j / (TRAIL - 1));
        ctx.beginPath();
        for (let i = 0; i < P.n; i++) {
          if (j + 1 >= P.len[i]) continue;
          const b = i * TRAIL + j;
          const x0 = P.hx[b], y0 = P.hy[b], x1 = P.hx[b + 1], y1 = P.hy[b + 1];
          if (x0 === x1 && y0 === y1) continue;
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const animating = () => st.open && st.particles && !P.moving && !document.hidden && !!dataOf() && P.n > 0;
    function frame() {
      P.raf = 0;
      if (!animating()) return;
      stepParticles();
      draw();
      P.raf = requestAnimationFrame(frame);
    }
    function startParticles() {
      if (P.raf || !animating()) return;
      if (reduceMotion.matches) {
        // Sin animación: una imagen fija con las estelas ya formadas.
        for (let k = 0; k < TRAIL * 2; k++) stepParticles();
        draw();
        return;
      }
      P.raf = requestAnimationFrame(frame);
    }
    function stopParticles() {
      if (P.raf) cancelAnimationFrame(P.raf);
      P.raf = 0;
      if (P.ctx) { P.ctx.setTransform(1, 0, 0, 1, 0, 0); P.ctx.clearRect(0, 0, P.canvas.width, P.canvas.height); }
    }
    function resetParticles() {
      stopParticles();
      if (!st.open || !st.particles) return;
      setupCanvas();
      buildField();
      seed();
      startParticles();
    }

    const onMoveStart = () => { P.moving = true; stopParticles(); };
    const onMoveEnd = () => { P.moving = false; resetParticles(); };
    const onClick = (e) => {
      st.point = { lat: e.latlng.lat, lon: ((e.latlng.lng + 540) % 360) - 180 };
      render();
      updateMarker();
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) startParticles(); });

    // ----------------------------------------------------------------
    // Hora que se ve

    function applyStep() {
      repaintColor();
      if (st.particles && P.n) { buildField(); startParticles(); } else resetParticles();
      renderTimeline();
      render();
      updateMarker();
    }

    function goTo(i) {
      if (!st.steps.length) return;
      st.cur = Math.max(0, Math.min(st.steps.length - 1, i));
      const s = step();
      if (st.data.has(s.f)) applyStep();
      else {
        renderTimeline();
        loadStep(s).then(() => { if (step() === s) applyStep(); }, () => {});
      }
    }
    function stepBy(d) { if (st.steps.length) goTo((st.cur + d + st.steps.length) % st.steps.length); }
    function scheduleNext() {
      clearTimeout(st.timer);
      if (!st.playing) return;
      st.timer = setTimeout(() => {
        const next = (st.cur + 1) % st.steps.length;
        // Espera a que llegue la siguiente hora en lugar de saltársela.
        if (st.data.has(st.steps[next].f)) goTo(next);
        scheduleNext();
      }, st.cur === st.steps.length - 1 ? PLAY_MS * 2 : PLAY_MS);
    }
    function play() { if (!st.steps.length) return; st.playing = true; dom.tl.root.classList.add('playing'); updatePlayTitle(); scheduleNext(); }
    function pause() { st.playing = false; dom.tl.root.classList.remove('playing'); updatePlayTitle(); clearTimeout(st.timer); }
    function toggle() { if (st.playing) pause(); else play(); }
    function updatePlayTitle() { dom.tl.play.title = t(st.playing ? 'ui.pause' : 'ui.play'); }

    // ----------------------------------------------------------------
    // Línea de tiempo y leyenda

    function relText(i) {
      if (!i) return t('ui.now');
      return `+${Math.round((st.steps[i].t - st.steps[0].t) / HOUR)} h`;
    }

    function renderTimeline() {
      const { track } = dom.tl;
      const n = st.steps.length;
      if (track.childElementCount !== n) {
        track.innerHTML = '';
        for (let i = 0; i < n; i++) {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', 'option');
          b.addEventListener('click', () => { pause(); goTo(i); });
          track.appendChild(b);
        }
      }
      let ready = 0;
      [...track.children].forEach((b, i) => {
        const s = st.steps[i];
        const isReady = st.data.has(s.f);
        if (isReady) ready++;
        const day = i > 0 && !sameDay(s.t, st.steps[i - 1].t);
        b.className = 'tl-tick' + (isReady ? ' ready' : '') + (i === st.cur ? ' current' : '') + (day ? ' day' : '');
        b.title = `${weekday(s.t)} ${clock(s.t)}`;
        b.setAttribute('aria-selected', i === st.cur ? 'true' : 'false');
      });
      const s = step();
      dom.tl.time.textContent = s ? `${weekday(s.t)} ${clock(s.t)}` : '--:--';
      dom.tl.rel.textContent = s ? relText(st.cur) : '';
      dom.tl.loading.textContent = n && ready < n ? t('viento.loadingSteps', { n: ready, total: n }) : '';
    }

    function renderLegend() {
      const stops = WG.ANCHORS.filter(([v]) => v <= LEGEND_MAX).map(([v, c]) => `rgb(${c.join(',')}) ${((v / LEGEND_MAX) * 100).toFixed(1)}%`);
      stops.push(`${WG.css(LEGEND_MAX)} 100%`);
      const marks = mph() ? [0, 10, 20, 30, 40, 50, 60, 70] : [0, 20, 40, 60, 80, 100, 120];
      const perMs = mph() ? 2.236936 : 3.6;
      let html = `<div class="vt-legend-title">${esc(t(st.field === 'gust' ? 'viento.keyGust' : 'viento.keyWind'))} · ${unit()}</div>`;
      html += `<div class="vt-legend-bar" style="background:linear-gradient(to right, ${stops.join(', ')})"></div><div class="vt-legend-scale">`;
      for (const m of marks) {
        const pos = (m / perMs / LEGEND_MAX) * 100;
        if (pos <= 100) html += `<span style="left:${pos.toFixed(1)}%">${m}</span>`;
      }
      dom.tl.legend.innerHTML = html + '</div>';
    }

    // ----------------------------------------------------------------
    // Punto del panel: el pinchado en el mapa o la ubicación activa

    function place() {
      if (st.point) return { ...st.point, picked: true, name: t('viento.point') };
      const loc = getPlace();
      return loc ? { lat: loc.lat, lon: loc.lon, name: loc.name, picked: false } : null;
    }

    function series(p) {
      const g = st.index.grid;
      return st.steps.map((s) => { const d = st.data.get(s.f); return d ? WG.sample(d, g, p.lat, p.lon) : null; });
    }

    function updateMarker() {
      const p = st.open && st.index ? place() : null;
      const w = p && dataOf() ? WG.sample(dataOf(), st.index.grid, p.lat, p.lon) : null;
      if (!p || !w) { if (st.marker) { st.marker.remove(); st.marker = null; } return; }
      const html = `<div class="vt-pick${p.picked ? ' picked' : ''}"><span class="vt-pick-dot"></span><span class="vt-pick-label">${w.speed >= 0.5 ? arrow(w.from) : ''}${esc(speed(w.speed))}</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] });
      if (!st.marker) st.marker = L.marker([p.lat, p.lon], { icon, interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map);
      else { st.marker.setLatLng([p.lat, p.lon]); st.marker.setIcon(icon); }
    }

    // ----------------------------------------------------------------
    // Panel

    function nowHtml(p, w, s) {
      const head = `<div class="vt-place"><span class="vt-place-name">${esc(p.name)}</span>${p.picked ? `<small>${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</small>` : ''}</div>` +
        (p.picked && getPlace() ? `<button type="button" class="link-btn small" data-back>${esc(t('viento.backTo', { name: getPlace().name }))}</button>` : '');
      const time = `<p class="vt-time">${esc(st.cur === 0 ? t('ui.now') : `${weekday(s.t, 'long')} ${clock(s.t)} · ${relText(st.cur)}`)}</p>`;
      if (!w) {
        const msg = dataOf() ? t('viento.outside', { model: modelName() }) : t('viento.loading');
        return head + time + `<p class="hint">${esc(msg)}</p>`;
      }
      const bft = WG.beaufort(w.speed);
      const calm = w.speed < 0.5;
      const dir = calm ? t('viento.calm') : D.cap(t('viento.from', { dir: D.dirName(getT(), w.from) }));
      return head + time +
        `<div class="vt-big">${calm ? '' : arrow(w.from)}<span>${Math.round(val(w.speed))}</span><small>${unit()}</small></div>` +
        `<p class="vt-line">${esc(dir)} · ${esc(t('viento.gusts', { speed: speed(w.gust) }))}</p>` +
        `<p class="vt-bft">${esc(t('viento.bft', { n: bft, name: getT().raw('viento.bftNames')[bft] }))}</p>`;
    }

    function niceMax(v) {
      return [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250].find((s) => s >= v) || Math.ceil(v / 50) * 50;
    }

    const CH = { W: 336, H: 150, L: 4, R: 4, T: 34, B: 18 };
    // Posición en la gráfica a escala de tiempo: hay modelos que van de hora en hora y luego de 3 en 3.
    function chartX() {
      const t0 = st.steps[0].t, span = Math.max(HOUR, st.steps[st.steps.length - 1].t - t0);
      const pw = CH.W - CH.L - CH.R - 8;
      return (ts) => CH.L + 4 + ((ts - t0) / span) * pw;
    }
    function chartHtml(ser) {
      const n = ser.length;
      const { W, H, T } = CH;
      const ph = H - T - CH.B;
      const X = chartX();
      const x = (i) => X(st.steps[i].t);
      const t0 = st.steps[0].t, tN = st.steps[n - 1].t;
      const top = niceMax(Math.max(mph() ? 10 : 20, ...ser.map((w) => (w ? val(w.gust) : 0))) * 1.08);
      const y = (v) => T + ph - (Math.min(v, top) / top) * ph;
      const path = (get) => {
        let d = '', pen = false;
        ser.forEach((w, i) => {
          if (!w) { pen = false; return; }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(get(w)).toFixed(1)}`;
          pen = true;
        });
        return d;
      };
      let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('viento.chart'))}">`;
      for (const f of [0, 0.5, 1]) svg += `<line class="grid" x1="${CH.L}" x2="${W - CH.R}" y1="${(T + ph * f).toFixed(1)}" y2="${(T + ph * f).toFixed(1)}"/>`;
      svg += `<text class="axis" x="${CH.L}" y="${T - 4}">${top} ${unit()}</text>`;
      // Horas (cada 6 o cada 12, según lo que abarque) y días, con un separador en cada medianoche.
      const every = tN - t0 > 60 * HOUR ? 12 : 6;
      const mark = new Date(t0);
      mark.setMinutes(0, 0, 0);
      while (mark.getTime() < t0 || mark.getHours() % every) mark.setHours(mark.getHours() + 1);
      for (; mark.getTime() <= tN; mark.setHours(mark.getHours() + every)) {
        const mx = X(mark.getTime()), h = mark.getHours();
        if (h === 0) svg += `<line class="grid day" x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${T}" y2="${T + ph}"/>`;
        if (mx < 8 || mx > W - 8) continue;
        svg += `<text class="axis${h === 0 ? ' strong' : ''}" x="${mx.toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(h === 0 ? weekday(mark.getTime()) : `${h}h`)}</text>`;
      }
      // Área bajo el viento medio, por tramos sin huecos; encima, las líneas.
      for (let i = 0; i < n; i++) {
        if (!ser[i] || ser[i - 1]) continue;
        let j = i;
        while (j + 1 < n && ser[j + 1]) j++;
        const line = ser.slice(i, j + 1).map((v, k) => `${k ? 'L' : 'M'}${x(i + k).toFixed(1)},${y(val(v.speed)).toFixed(1)}`).join('');
        svg += `<path class="vt-speed-area" d="${line}L${x(j).toFixed(1)},${T + ph}L${x(i).toFixed(1)},${T + ph}Z"/>`;
      }
      svg += `<path class="vt-gust" d="${path((w) => val(w.gust))}"/>`;
      svg += `<path class="vt-speed" d="${path((w) => val(w.speed))}"/>`;
      // Dirección arriba, con sitio entre flechas.
      let last = -Infinity;
      ser.forEach((w, i) => {
        if (!w || w.speed < 0.5 || x(i) - last < 19) return;
        last = x(i);
        svg += `<g transform="translate(${x(i).toFixed(1)},9) rotate(${Math.round(w.from)})"><path class="vt-dir" d="M0,-5.5V4.5M-3,1.5 0,4.5 3,1.5"/></g>`;
      });
      svg += `<line class="now-line" x1="${x(st.cur).toFixed(1)}" x2="${x(st.cur).toFixed(1)}" y1="${T - 2}" y2="${T + ph}"/>`;
      if (st.hover !== null && st.hover !== st.cur) svg += `<line class="vt-hover" x1="${x(st.hover).toFixed(1)}" x2="${x(st.hover).toFixed(1)}" y1="${T - 2}" y2="${T + ph}"/>`;
      return svg + '</svg>';
    }

    function readout(ser, i) {
      const w = ser[i], s = st.steps[i];
      if (!s) return '';
      const time = `${weekday(s.t)} ${clock(s.t)}`;
      if (!w) return `${time} · ${t('viento.loading')}`;
      const dir = w.speed < 0.5 ? t('viento.calm').toLowerCase() : D.dirShort(getT(), w.from);
      return `${time} · ${speed(w.speed)} ${dir} · ${t('viento.gusts', { speed: speed(w.gust) })}`;
    }

    const modelName = () => WG.MODELS.find((m) => m.id === st.model).name;
    // Selector de modelo: siempre visible, también si un modelo no ha cargado.
    function modelsHtml() {
      return `<section class="vt-models">
          <div class="seg small" role="group" aria-label="${esc(t('viento.model'))}">
            ${WG.MODELS.map((m) => `<button type="button" data-model="${m.id}" aria-pressed="${st.model === m.id}">${esc(m.name)}</button>`).join('')}
          </div>
          <p class="hint">${esc(t('viento.m.' + st.model))}</p>
        </section>`;
    }

    function render() {
      if (!st.open) return;
      const el = dom.panel;
      if (!st.index) {
        el.innerHTML = modelsHtml() + `<p class="hint agua-msg">${esc(st.error ? t('viento.error', { model: modelName() }) : t('viento.loading'))}</p>`;
        return;
      }
      const p = place();
      const s = step();
      let html = modelsHtml();
      if (!p) {
        html += `<section class="vt-now"><p class="hint">${esc(t('viento.pickHint'))}</p></section>`;
      } else {
        const ser = series(p);
        const w = ser[st.cur];
        html += `<section class="vt-now">${nowHtml(p, w, s)}</section>`;
        if (ser.some(Boolean)) {
          let best = -1;
          ser.forEach((v, i) => { if (v && (best < 0 || v.gust > ser[best].gust)) best = i; });
          const ready = ser.filter(Boolean).length;
          html += `<section class="block vt-forecast">
            <div class="block-head"><h2>${esc(t('viento.next', { n: Math.round((st.steps[st.steps.length - 1].t - st.steps[0].t) / HOUR) }))}</h2>
              <div class="keys"><span class="key key-wind">${esc(t('viento.keyWind'))}</span><span class="key key-gust">${esc(t('viento.keyGust'))}</span></div></div>
            <div class="chart vt-chart">${chartHtml(ser)}</div>
            <p class="vt-readout">${esc(readout(ser, st.hover !== null ? st.hover : st.cur))}</p>
            ${best >= 0 ? `<p class="vt-max">${esc(t('viento.max', { speed: speed(ser[best].gust), when: when(st.steps[best].t) }))}${ready < ser.length ? ` <span class="hint">${esc(t('viento.partial'))}</span>` : ''}</p>` : ''}
          </section>`;
        }
        if (!p.picked) html += `<p class="hint vt-pick-hint">${esc(t('viento.pickHint'))}</p>`;
      }
      html += `<section class="block vt-controls">
          <div class="seg" role="group" aria-label="${esc(t('viento.colorBy'))}">
            <button type="button" data-field="speed" aria-pressed="${st.field === 'speed'}">${esc(t('viento.keyWind'))}</button>
            <button type="button" data-field="gust" aria-pressed="${st.field === 'gust'}">${esc(t('viento.keyGust'))}</button>
          </div>
          <label class="switch-row"><input type="checkbox" data-particles ${st.particles ? 'checked' : ''}> <span>${esc(t('viento.particles'))}</span></label>
        </section>
        <footer class="agua-sources"><p>${esc(t('viento.src.' + st.model, { day: weekday(st.index.runTime, 'long'), time: clock(st.index.runTime) }))}</p></footer>`;
      el.innerHTML = html;
    }

    // Eventos del panel (delegados: el contenido se rehace a menudo).
    dom.panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && b.dataset.model) { setModel(b.dataset.model); return; }
      if (b && b.dataset.field) { st.field = b.dataset.field; repaintColor(); renderLegend(); render(); return; }
      if (b && 'back' in b.dataset) { st.point = null; render(); updateMarker(); const loc = getPlace(); if (loc) map.panTo([loc.lat, loc.lon]); return; }
      const svg = e.target.closest('.vt-chart svg');
      if (svg) { const i = chartIndex(svg, e); if (i !== null) { pause(); goTo(i); } }
    });
    dom.panel.addEventListener('change', (e) => {
      if (e.target.matches('[data-particles]')) { st.particles = e.target.checked; resetParticles(); }
    });
    dom.panel.addEventListener('mousemove', (e) => {
      const svg = e.target.closest('.vt-chart svg');
      const i = svg ? chartIndex(svg, e) : null;
      if (i === st.hover) return;
      st.hover = i;
      hoverRender();
    });
    dom.panel.addEventListener('mouseleave', () => { if (st.hover !== null) { st.hover = null; hoverRender(); } });
    function chartIndex(svg, e) {
      const r = svg.getBoundingClientRect();
      const n = st.steps.length;
      if (!n || !r.width) return null;
      const px = ((e.clientX - r.left) / r.width) * CH.W;
      if (px < CH.L || px > CH.W - CH.R) return null;
      const X = chartX();
      let best = 0;
      st.steps.forEach((s, i) => { if (Math.abs(X(s.t) - px) < Math.abs(X(st.steps[best].t) - px)) best = i; });
      return best;
    }
    // Solo la gráfica y la línea de lectura: rehacer todo el panel con cada movimiento del ratón sobra.
    function hoverRender() {
      const p = place();
      const chart = dom.panel.querySelector('.vt-chart');
      if (!p || !chart) return;
      const ser = series(p);
      chart.innerHTML = chartHtml(ser);
      const ro = dom.panel.querySelector('.vt-readout');
      if (ro) ro.textContent = readout(ser, st.hover !== null ? st.hover : st.cur);
    }

    dom.tl.play.addEventListener('click', toggle);
    dom.tl.prev.addEventListener('click', () => { pause(); stepBy(-1); });
    dom.tl.next.addEventListener('click', () => { pause(); stepBy(1); });

    // Otro modelo: se mantienen la hora (la más cercana) y el punto.
    async function setModel(id) {
      if (id === st.model || !WG.MODELS.some((m) => m.id === id)) return;
      try { localStorage.setItem(MODEL_KEY, id); } catch (e) { /* almacenamiento bloqueado */ }
      const keep = step() && step().t;
      pause();
      st.model = id;
      st.index = null;
      st.error = null;
      st.steps = [];
      st.data.clear();
      st.loading.clear();
      st.gen++;
      st.hover = null;
      setAttribution(ATTR[id](getT()));
      repaintColor();
      stopParticles();
      P.n = 0;
      renderTimeline();
      render();
      updateMarker();
      await loadIndex(true);
      if (!st.open || st.model !== id || !st.index) { render(); return; }
      pickSteps(keep);
      // Si el mapa mira fuera de la zona del modelo (ICON-EU), se va a ella.
      const g = st.index.grid, c = map.getCenter();
      if (!WG.cell(g, c.lat, c.lng)) map.setView([g.north - ((g.rows - 1) * g.step) / 2, g.west + ((g.cols - 1) * g.step) / 2], 6);
      goTo(st.cur);
      prefetch();
    }

    // ----------------------------------------------------------------

    async function open() {
      if (st.open) return;
      st.open = true;
      st.point = null;
      st.placeKey = getPlace() ? getPlace().id : null;
      setAttribution(ATTR[st.model](getT()));
      st.prevView = { center: map.getCenter(), zoom: map.getZoom() };
      if (map.getZoom() > MAX_ZOOM) map.setZoom(MAX_ZOOM, { animate: false });
      colorLayer.addTo(map);
      map.on('movestart zoomstart', onMoveStart);
      map.on('moveend resize', onMoveEnd);
      map.on('click', onClick);
      renderLegend();
      renderTimeline();
      render();
      await loadIndex();
      if (!st.open) return;
      renderTimeline();
      render();
      if (!st.index) return;
      goTo(st.cur);
      prefetch();
      // Cada 10 min: la hora en curso avanza y puede haber una pasada nueva.
      clearInterval(st.refresher);
      st.refresher = setInterval(async () => {
        const run = st.index && st.index.run;
        await loadIndex(true);
        if (!st.open || !st.index) return;
        if (st.index.run !== run) { goTo(st.cur); prefetch(); } else { renderTimeline(); render(); }
      }, 10 * 60000);
    }

    function close() {
      if (!st.open) return;
      st.open = false;
      pause();
      clearInterval(st.refresher);
      stopParticles();
      map.off('movestart zoomstart', onMoveStart);
      map.off('moveend resize', onMoveEnd);
      map.off('click', onClick);
      map.removeLayer(colorLayer);
      if (st.marker) { st.marker.remove(); st.marker = null; }
      st.point = null;
      st.hover = null;
      setAttribution(null);
      if (st.prevView) map.setView(st.prevView.center, st.prevView.zoom, { animate: false });
    }

    return {
      open, close, toggle, pause,
      step: stepBy,
      goLatest: () => goTo(0),
      isOpen: () => st.open,
      // Idioma, unidades o ubicación activa cambiados.
      refresh() {
        if (!st.open) return;
        const loc = getPlace();
        const key = loc ? loc.id : null;
        if (key !== st.placeKey) { st.placeKey = key; st.point = null; }
        setAttribution(ATTR[st.model](getT()));
        updatePlayTitle();
        renderLegend();
        renderTimeline();
        render();
        updateMarker();
      }
    };
  }

  window.RA_VIENTO = { create };
})();
