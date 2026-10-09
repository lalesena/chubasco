// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/* Modo «Previsión»: el viento, la lluvia o la temperatura de un modelo (ECMWF,
 * ICON-EU o GFS) sobre el mapa, en tres pestañas. El viento lleva partículas
 * que lo siguen y el fondo coloreado por la velocidad (o por las rachas); la
 * lluvia, los colores del radar; la temperatura, una escala divergente. Con
 * una línea de tiempo y, en el panel, el valor en la ubicación activa o en el
 * punto que se pinche, con la gráfica de las próximas horas. Los datos los
 * publica la web cada hora (scripts/viento/datos.mjs; formatos en
 * src/shared/windgrid.js y metgrid.js). */
(function () {
  'use strict';
  const L = window.L;
  const WG = window.RA_WINDGRID;
  const MG = window.RA_METGRID;
  const PAL = window.RA_PALETTE;
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
  // Atribución en el mapa de cada modelo (ECMWF y el DWD piden la licencia y avisar de que los datos están procesados);
  // `what` es lo que se ve en la pestaña (viento, lluvia o temperatura).
  const ATTR = {
    ecmwf: (t, what) => `${what} <a href="https://www.ecmwf.int/">ECMWF</a> IFS (${CC_BY}, ${t('map.processed')})`,
    'icon-eu': (t, what) => `${what} ICON-EU © <a href="https://www.dwd.de/">DWD</a> (${CC_BY}, ${t('map.processed')})`,
    gfs: (t, what) => `${what} <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast">GFS</a> (NOAA)`
  };
  const MODEL_KEY = 'chubasco.viento.modelo';
  function savedModel() {
    try { const m = localStorage.getItem(MODEL_KEY); if (WG.MODELS.some((x) => x.id === m)) return m; } catch (e) { /* almacenamiento bloqueado */ }
    return WG.MODELS[0].id;
  }
  const TABS = ['wind', 'rain', 'temp'];
  const TAB_KEY = 'chubasco.viento.pestana';
  function savedTab() {
    try { const m = localStorage.getItem(TAB_KEY); if (TABS.includes(m)) return m; } catch (e) { /* almacenamiento bloqueado */ }
    return TABS[0];
  }
  // Qué se pinta en el mapa en cada caso: la tabla de colores, cómo elegir la casilla de un valor, el campo de los
  // datos leídos y la opacidad (la lluvia es transparente donde no llueve).
  const COLOR = {
    speed: { lut: WG.colorTable(), index: (v) => (v / WG.LUT_STEP) | 0, field: 'speed', opacity: 0.72 },
    gust: { lut: WG.colorTable(), index: (v) => (v / WG.LUT_STEP) | 0, field: 'gust', opacity: 0.72 },
    rain: { lut: MG.rainColorTable(), index: (v) => MG.rainIndex(v), field: 'rain', opacity: 0.88 },
    temp: { lut: MG.tempColorTable(), index: (v) => MG.tempIndex(v), field: 'temp', opacity: 0.8 }
  };
  const LEG_TEMP = [-20, 45];      // °C de los extremos de la leyenda de temperatura
  const LEG_DBZ = [7, 55];         // dBZ de los extremos de la leyenda de lluvia (7 dBZ ≈ 0,1 mm/h; 55 dBZ ≈ 100 mm/h)
  // Flecha hacia abajo: girada `from` grados apunta hacia donde va el viento.
  const ARROW = '<svg class="vt-arrow" viewBox="0 0 16 16" aria-hidden="true" style="transform:rotate({deg}deg)"><path d="M8 2v11M3.8 8.8 8 13l4.2-4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const arrow = (from) => ARROW.replace('{deg}', Math.round(from));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function create({ map, api, dom, getT, getUnits, getPlace, setAttribution = () => {} }) {
    const st = {
      open: false, index: null, indexAt: 0, error: null, gen: 0,
      steps: [], data: new Map(), loading: new Map(),
      cur: 0, playing: false, timer: null, refresher: null,
      model: savedModel(), tab: savedTab(), field: 'speed', particles: true,
      point: null, placeKey: null, prevView: null, hover: null, marker: null
    };
    const t = (k, v) => getT()(k, v);
    const locale = () => (getT().lang === 'es' ? 'es-ES' : 'en-GB');
    const units = () => getUnits() || {};
    const mph = () => units().distance === 'mi';
    const val = (ms) => (mph() ? ms * 2.236936 : ms * 3.6);
    const unit = () => (mph() ? 'mph' : 'km/h');
    const speed = (ms) => D.fmtSpeed(getT(), ms * 3.6, units());
    const num = (v, digits) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(v);
    const rate = (mmh) => D.fmtRate(getT(), mmh, units());
    const amount = (mm) => D.fmtAmount(getT(), mm, units());
    const temp = (c) => D.fmtTemp(getT(), c, units());
    const tval = (c) => (mph() ? (c * 9) / 5 + 32 : c);   // temperatura en la unidad elegida
    const tunit = () => (mph() ? '°F' : '°C');
    const rainUnit = () => (units().rate === 'in' ? 'in/h' : 'mm/h');
    // [número, unidad] de una intensidad, para los números grandes.
    function rateParts(mmh) {
      const inch = units().rate === 'in';
      const v = inch ? mmh / 25.4 : mmh;
      return [num(v, inch ? (v < 0.1 ? 3 : 2) : v < 10 ? 1 : 0), rainUnit()];
    }
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

    // Cada hora tiene dos ficheros: el viento (f) y la lluvia y la temperatura (m); según la pestaña se lee uno u otro.
    const fileOf = (s) => (st.tab === 'wind' ? s.f : s.m);
    const colorKind = () => (st.tab === 'wind' ? st.field : st.tab);
    const attribution = () => ATTR[st.model](getT(), t(`viento.tab.${st.tab}`));
    const step = (i = st.cur) => st.steps[i] || null;
    const dataOf = (i = st.cur) => { const s = step(i); return s ? st.data.get(fileOf(s)) || null : null; };

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
    // En la lluvia y la temperatura, solo las horas que tienen su fichero (puede no haberlo, p. ej. en una pasada anterior a esta función).
    function pickSteps(keep = step() && step().t) {
      const metOk = !!st.index.met && st.index.met.v === 1;
      const all = st.index.steps.filter((s) => st.tab === 'wind' || (metOk && s.m));
      const now = Date.now();
      let first = 0;
      for (let i = 0; i < all.length; i++) if (all[i].t <= now) first = i;
      st.steps = all.slice(first);
      st.cur = 0;
      if (keep && st.steps.length) st.steps.forEach((s, i) => { if (Math.abs(s.t - keep) < Math.abs(st.steps[st.cur].t - keep)) st.cur = i; });
    }

    function loadStep(s) {
      const file = fileOf(s);
      if (st.data.has(file)) return Promise.resolve(st.data.get(file));
      if (!st.loading.has(file)) {
        const gen = st.gen, grid = st.index.grid, scale = st.index.scale, meta = st.index.met, model = st.model, wind = file === s.f;
        const p = (async () => {
          const raw = await WG.inflate(await api.viento(`${model}/${file}`));
          const d = wind ? WG.decode(raw, grid, scale) : MG.decode(raw, grid, meta);
          if (gen === st.gen) st.data.set(file, d);
          return d;
        })();
        st.loading.set(file, p);
        p.then(() => { if (st.loading.get(file) === p) st.loading.delete(file); },
          () => { if (st.loading.get(file) === p) st.loading.delete(file); });
      }
      return st.loading.get(file);
    }

    let failures = 0;
    function prefetch() {
      const gen = st.gen;
      const order = st.steps.map((_, i) => i).sort((a, b) => Math.abs(a - st.cur) - Math.abs(b - st.cur) || a - b);
      let active = 0;
      const next = () => {
        while (st.open && gen === st.gen && active < 3 && order.length) {
          const s = st.steps[order.shift()];
          if (!s || st.data.has(fileOf(s))) continue;
          active++;
          loadStep(s).then(() => { failures = 0; loaded(s); }, (e) => {
            console.warn('viento', fileOf(s), e);
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

    function paintTile(tile) {
      const ctx = tile.getContext('2d');
      const d = dataOf();
      const w = tile.width, h = tile.height;
      if (!d || !st.index) { ctx.clearRect(0, 0, w, h); return; }
      const g = st.index.grid;
      const spec = COLOR[colorKind()];
      const arr = d[spec.field], LUT = spec.lut, index = spec.index;
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
      const top = LUT.length - 1;
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
          px[o + x] = LUT[Math.min(top, index(v))];
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
    function repaintColor() {
      colorLayer.setOpacity(COLOR[colorKind()].opacity);
      for (const k in colorLayer._tiles) paintTile(colorLayer._tiles[k].el);
    }

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

    const animating = () => st.open && st.tab === 'wind' && st.particles && !P.moving && !document.hidden && !!dataOf() && P.n > 0;
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
      if (!st.open || st.tab !== 'wind' || !st.particles) return;
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
      if (st.tab === 'wind' && st.particles && P.n) { buildField(); startParticles(); } else resetParticles();
      renderTimeline();
      render();
      updateMarker();
    }

    function goTo(i) {
      if (!st.steps.length) return;
      st.cur = Math.max(0, Math.min(st.steps.length - 1, i));
      const s = step();
      if (st.data.has(fileOf(s))) applyStep();
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
        if (st.data.has(fileOf(st.steps[next]))) goTo(next);
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
        const isReady = st.data.has(fileOf(s));
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

    // Barra de colores con marcas: stops [[posición 0–1, color]], marks [[posición 0–1, texto]].
    function legendHtml(title, stops, marks) {
      const bar = stops.map(([pos, c]) => `${c} ${(pos * 100).toFixed(1)}%`).join(', ');
      let html = `<div class="vt-legend-title">${esc(title)}</div><div class="vt-legend-bar" style="background:linear-gradient(to right, ${bar})"></div><div class="vt-legend-scale">`;
      for (const [pos, text] of marks) if (pos >= 0 && pos <= 1) html += `<span style="left:${(pos * 100).toFixed(1)}%">${esc(text)}</span>`;
      return html + '</div>';
    }

    function renderLegend() {
      let html;
      if (st.tab === 'rain') {
        // Los colores del radar: la escala va en dBZ, como la leyenda del radar, con la intensidad de cada marca.
        const [lo, hi] = LEG_DBZ;
        const stops = [];
        for (let d = lo; d <= hi; d += 2) stops.push([(d - lo) / (hi - lo), MG.rainRgbaCss(PAL.dbzToRate(d, PAL.KIND_RAIN))]);
        const inch = units().rate === 'in';
        const marks = (inch ? [0.005, 0.05, 0.1, 0.5, 1, 2] : [0.1, 0.5, 1, 2, 5, 10, 25, 50])
          .map((v) => [(PAL.rateToDbz(inch ? v * 25.4 : v, PAL.KIND_RAIN) - lo) / (hi - lo), num(v, 3)]);
        html = legendHtml(`${t('viento.legend.rain')} · ${rainUnit()}`, stops, marks);
      } else if (st.tab === 'temp') {
        const [lo, hi] = LEG_TEMP;
        const stops = [[0, MG.tempCss(lo)], ...MG.TEMP_ANCHORS.filter(([c]) => c > lo && c < hi).map(([c]) => [(c - lo) / (hi - lo), MG.tempCss(c)]), [1, MG.tempCss(hi)]];
        const marks = (mph() ? [0, 20, 40, 60, 80, 100] : [-20, -10, 0, 10, 20, 30, 40]).map((v) => [((mph() ? ((v - 32) * 5) / 9 : v) - lo) / (hi - lo), String(v)]);
        html = legendHtml(`${t('viento.legend.temp')} · ${tunit()}`, stops, marks);
      } else {
        const stops = WG.ANCHORS.filter(([v]) => v <= LEGEND_MAX).map(([v, c]) => [v / LEGEND_MAX, `rgb(${c.join(',')})`]);
        stops.push([1, WG.css(LEGEND_MAX)]);
        const perMs = mph() ? 2.236936 : 3.6;
        const marks = (mph() ? [0, 10, 20, 30, 40, 50, 60, 70] : [0, 20, 40, 60, 80, 100, 120]).map((m) => [m / perMs / LEGEND_MAX, String(m)]);
        html = legendHtml(`${t(st.field === 'gust' ? 'viento.keyGust' : 'viento.keyWind')} · ${unit()}`, stops, marks);
      }
      dom.tl.legend.innerHTML = html;
    }

    // ----------------------------------------------------------------
    // Punto del panel: el pinchado en el mapa o la ubicación activa

    function place() {
      if (st.point) return { ...st.point, picked: true, name: t('viento.point') };
      const loc = getPlace();
      return loc ? { lat: loc.lat, lon: loc.lon, name: loc.name, picked: false } : null;
    }

    // El valor de una hora en el punto: el viento, o la lluvia (con la duración de su tramo) y la temperatura.
    function valueAt(s, p) {
      const d = st.data.get(fileOf(s));
      if (!d) return null;
      if (st.tab === 'wind') return WG.sample(d, st.index.grid, p.lat, p.lon);
      const x = MG.sample(d, st.index.grid, p.lat, p.lon);
      return x && { ...x, span: s.span || 0 };
    }
    const series = (p) => st.steps.map((s) => valueAt(s, p));

    function markerText(w) {
      if (st.tab === 'rain') return w.span > 0 ? esc(rate(w.rain < MG.RAIN_MIN ? 0 : w.rain)) : '';
      if (st.tab === 'temp') return esc(temp(w.temp));
      return `${w.speed >= 0.5 ? arrow(w.from) : ''}${esc(speed(w.speed))}`;
    }

    function updateMarker() {
      const p = st.open && st.index ? place() : null;
      const w = p && step() ? valueAt(step(), p) : null;
      if (!p || !w) { if (st.marker) { st.marker.remove(); st.marker = null; } return; }
      const html = `<div class="vt-pick${p.picked ? ' picked' : ''}"><span class="vt-pick-dot"></span><span class="vt-pick-label">${markerText(w)}</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] });
      if (!st.marker) st.marker = L.marker([p.lat, p.lon], { icon, interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map);
      else { st.marker.setLatLng([p.lat, p.lon]); st.marker.setIcon(icon); }
    }

    // ----------------------------------------------------------------
    // Panel

    function headHtml(p) {
      return `<div class="vt-place"><span class="vt-place-name">${esc(p.name)}</span>${p.picked ? `<small>${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</small>` : ''}</div>` +
        (p.picked && getPlace() ? `<button type="button" class="link-btn small" data-back>${esc(t('viento.backTo', { name: getPlace().name }))}</button>` : '');
    }

    function windNowHtml(w) {
      const bft = WG.beaufort(w.speed);
      const calm = w.speed < 0.5;
      const dir = calm ? t('viento.calm') : D.cap(t('viento.from', { dir: D.dirName(getT(), w.from) }));
      return `<div class="vt-big">${calm ? '' : arrow(w.from)}<span>${Math.round(val(w.speed))}</span><small>${unit()}</small></div>` +
        `<p class="vt-line">${esc(dir)} · ${esc(t('viento.gusts', { speed: speed(w.gust) }))}</p>` +
        `<p class="vt-bft">${esc(t('viento.bft', { n: bft, name: getT().raw('viento.bftNames')[bft] }))}</p>`;
    }

    // Lluvia: de una hora, el tramo anterior; la «lluvia» es la de 0,1 mm/h o más (lo que el radar ya enseña).
    const spanText = (span) => t(span === 1 ? 'viento.rain.span1' : 'viento.rain.spanN', { n: span });
    const isWet = (w) => w.rain >= MG.RAIN_MIN;

    // Lluvia que cae entre dos instantes: la media de cada tramo por las horas que le tocan.
    function rainTotal(ser, from, to) {
      let mm = 0, partial = false;
      st.steps.forEach((s, i) => {
        if (!(s.span > 0)) return;
        const a = Math.max(from, s.t - s.span * HOUR), b = Math.min(to, s.t);
        if (b <= a) return;
        if (!ser[i]) { partial = true; return; }
        if (isWet(ser[i])) mm += ser[i].rain * ((b - a) / HOUR);
      });
      return { mm, partial };
    }

    // Cuándo empieza o deja de llover y cuánto cae, contando desde ahora (los tramos que acaban más tarde).
    function rainOutlookHtml(ser) {
      const now = Date.now();
      const fut = [];
      st.steps.forEach((s, i) => { if (s.span > 0 && s.t > now) fut.push(i); });
      if (!fut.length) return '';
      const startOf = (i) => Math.max(now, st.steps[i].t - st.steps[i].span * HOUR);
      const avail = Math.floor((st.steps[st.steps.length - 1].t - now) / HOUR);
      let text = '';
      if (ser[fut[0]]) {
        // El primer tramo que cambia: si se queda sin cargar antes de encontrarlo, aún no se sabe.
        const wet = isWet(ser[fut[0]]);
        let k = 1;
        while (k < fut.length && ser[fut[k]] && isWet(ser[fut[k]]) === wet) k++;
        if (k === fut.length) text = wet ? t('viento.rain.all') : t('viento.rain.none', { n: avail });
        else if (ser[fut[k]]) text = wet ? t('viento.rain.now', { when: when(startOf(fut[k])) }) : t('viento.rain.starts', { when: when(startOf(fut[k])) });
      }
      const wins = avail > 24 ? [24, Math.min(48, avail)] : [Math.max(1, avail)];
      const rows = wins.map((n) => ({ n, ...rainTotal(ser, now, now + n * HOUR) }));
      return `<p class="vt-line vt-outlook">${esc(text || t('viento.loading'))}</p>` +
        `<ul class="vt-totals">${rows.map((r) => `<li${r.partial ? ' class="partial"' : ''}><span>${esc(t('viento.rain.next', { n: r.n }))}</span><b>${esc(amount(r.mm))}</b></li>`).join('')}</ul>`;
    }

    function rainNowHtml(ser) {
      const w = ser[st.cur];
      if (!(w.span > 0)) return `<p class="hint">${esc(t('viento.rain.noData'))}</p>` + rainOutlookHtml(ser);
      const dry = !isWet(w);
      const [v, u] = rateParts(dry ? 0 : w.rain);
      const line = dry ? t(w.span === 1 ? 'viento.rain.dry1' : 'viento.rain.dryN', { n: w.span }) : D.cap(spanText(w.span));
      return `<div class="vt-big"><span>${v}</span><small>${u}</small></div><p class="vt-line">${esc(line)}</p>` + rainOutlookHtml(ser);
    }

    // Temperatura: máxima y mínima de cada día con las horas de la previsión (el primero, desde ahora).
    function dailyRanges(ser) {
      const days = [];
      st.steps.forEach((s, i) => {
        let d = days[days.length - 1];
        if (!d || !sameDay(d.t0, s.t)) { d = { t0: s.t, t1: s.t, min: Infinity, max: -Infinity, n: 0 }; days.push(d); }
        d.t1 = s.t;
        if (ser[i]) { d.min = Math.min(d.min, ser[i].temp); d.max = Math.max(d.max, ser[i].temp); d.n++; }
      });
      // Un día cortado por el final de la previsión (o con una sola hora) no dice nada de su máxima y su mínima.
      return days.filter((d, k) => d.n > 0 && (k === 0 ? d.n > 1 || days.length === 1 : d.t1 - d.t0 >= 12 * HOUR));
    }

    function tempNowHtml(ser) {
      const w = ser[st.cur];
      const day = dailyRanges(ser).find((d) => sameDay(d.t0, step().t));
      return `<div class="vt-big"><span>${Math.round(tval(w.temp))}</span><small>${tunit()}</small></div>` +
        (day ? `<p class="vt-line">${esc(t('viento.temp.today', { max: temp(day.max), min: temp(day.min) }))}</p>` : '');
    }

    function daysHtml(ser) {
      const days = dailyRanges(ser);
      if (!days.length) return '';
      const lo = Math.min(...days.map((d) => d.min)), hi = Math.max(...days.map((d) => d.max));
      const full = Math.max(1, hi - lo);
      const now = Date.now();
      const label = (d) => (sameDay(d.t0, now) ? t('viento.day.today') : sameDay(d.t0, now + 24 * HOUR) ? t('viento.day.tomorrow')
        : D.cap(new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric' }).format(new Date(d.t0))));
      const rows = days.map((d) => {
        // La barra va del mínimo al máximo del día, con los colores del mapa.
        const stops = [[0, d.min], ...MG.TEMP_ANCHORS.filter(([c]) => c > d.min && c < d.max).map(([c]) => [(c - d.min) / (d.max - d.min), c]), [1, d.max]]
          .map(([pos, c]) => `${MG.tempCss(c)} ${(pos * 100).toFixed(1)}%`).join(', ');
        const left = ((d.min - lo) / full) * 100, width = Math.max(2, ((d.max - d.min) / full) * 100);
        return `<li><span class="vt-day">${esc(label(d))}</span><span class="vt-tmin">${Math.round(tval(d.min))}°</span>` +
          `<span class="vt-trange"><i style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;background:linear-gradient(to right, ${stops})"></i></span>` +
          `<span class="vt-tmax">${Math.round(tval(d.max))}°</span></li>`;
      });
      return `<section class="block vt-days"><div class="block-head"><h2>${esc(t('viento.temp.days'))}</h2></div><ul>${rows.join('')}</ul><p class="hint">${esc(t('viento.temp.daysHint'))}</p></section>`;
    }

    function nowHtml(p, ser, s) {
      const w = ser[st.cur];
      const head = headHtml(p) + `<p class="vt-time">${esc(st.cur === 0 ? t('ui.now') : `${weekday(s.t, 'long')} ${clock(s.t)} · ${relText(st.cur)}`)}</p>`;
      if (!w) {
        const msg = dataOf() ? t('viento.outside', { model: modelName() }) : t('viento.loading');
        return head + `<p class="hint">${esc(msg)}</p>`;
      }
      return head + (st.tab === 'rain' ? rainNowHtml(ser) : st.tab === 'temp' ? tempNowHtml(ser) : windNowHtml(w));
    }

    function niceMax(v) {
      return [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250].find((s) => s >= v) || Math.ceil(v / 50) * 50;
    }
    const niceRain = (v) => [2, 5, 10, 20, 50, 100].find((s) => s >= v) || 100;

    const CH = { W: 336, H: 150, L: 4, R: 4, T: 34, B: 18 };
    // Posición en la gráfica a escala de tiempo: hay modelos que van de hora en hora y luego de 3 en 3.
    function chartX(t0 = st.steps[0].t) {
      const span = Math.max(HOUR, st.steps[st.steps.length - 1].t - t0);
      const pw = CH.W - CH.L - CH.R - 8;
      return (ts) => CH.L + 4 + ((ts - t0) / span) * pw;
    }
    // Horas (cada 6 o cada 12, según lo que abarque) y días, con un separador en cada medianoche.
    function axisSvg(X, t0, tN) {
      const { W, H, T } = CH;
      const ph = H - T - CH.B;
      let svg = '';
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
      return svg;
    }
    // La hora que se ve y, si el ratón pasa por la gráfica, la del puntero.
    function cursorSvg(x) {
      const { T } = CH;
      const ph = CH.H - T - CH.B;
      let svg = `<line class="now-line" x1="${x(st.cur).toFixed(1)}" x2="${x(st.cur).toFixed(1)}" y1="${T - 2}" y2="${T + ph}"/>`;
      if (st.hover !== null && st.hover !== st.cur) svg += `<line class="vt-hover" x1="${x(st.hover).toFixed(1)}" x2="${x(st.hover).toFixed(1)}" y1="${T - 2}" y2="${T + ph}"/>`;
      return svg;
    }
    // Tramos seguidos con dato: [[desde, hasta]…].
    function runs(ser) {
      const out = [];
      for (let i = 0; i < ser.length; i++) {
        if (!ser[i] || ser[i - 1]) continue;
        let j = i;
        while (j + 1 < ser.length && ser[j + 1]) j++;
        out.push([i, j]);
      }
      return out;
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
      svg += axisSvg(X, t0, tN);
      // Área bajo el viento medio, por tramos sin huecos; encima, las líneas.
      for (const [i, j] of runs(ser)) {
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
      return svg + cursorSvg(x) + '</svg>';
    }

    // Lluvia: una barra por tramo (de donde empieza a donde acaba), con la escala de raíz cuadrada y los colores del radar.
    function rainChartHtml(ser) {
      const { W, H, T } = CH;
      const ph = H - T - CH.B;
      const first = st.steps[0];
      const t0 = first.t - (first.span || 0) * HOUR, tN = st.steps[st.steps.length - 1].t;
      const X = chartX(t0);
      const top = niceRain(Math.max(2, ...ser.map((w) => (w ? w.rain : 0))) * 1.1);
      const y = (v) => T + ph - Math.sqrt(Math.min(v, top) / top) * ph;
      let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('viento.rain.chart'))}">`;
      for (const g of [0.25, 0.5, 1]) svg += `<line class="grid" x1="${CH.L}" x2="${W - CH.R}" y1="${y(top * g * g).toFixed(1)}" y2="${y(top * g * g).toFixed(1)}"/>`;
      svg += `<text class="axis" x="${CH.L}" y="${T - 4}">${esc(rate(top))}</text>`;
      svg += axisSvg(X, t0, tN);
      // El tramo que se ve y el del puntero, resaltados.
      for (const i of new Set([st.cur, st.hover !== null ? st.hover : st.cur])) {
        const s = st.steps[i], span = (s.span || 0) * HOUR;
        if (span) svg += `<rect class="vt-col${i === st.cur ? ' cur' : ''}" x="${X(s.t - span).toFixed(1)}" y="${T}" width="${(X(s.t) - X(s.t - span)).toFixed(1)}" height="${ph}"/>`;
      }
      ser.forEach((w, i) => {
        const s = st.steps[i];
        if (!(s.span > 0)) return;
        const x0 = X(s.t - s.span * HOUR), x1 = X(s.t);
        if (!w) { svg += `<rect class="unknown" x="${x0.toFixed(1)}" y="${T + ph - 2}" width="${Math.max(1, x1 - x0 - 1).toFixed(1)}" height="2"/>`; return; }
        if (!isWet(w)) return;
        const yy = y(w.rain);
        svg += `<rect class="bar" x="${x0.toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.max(1, x1 - x0 - 1).toFixed(1)}" height="${(T + ph - yy).toFixed(1)}" fill="${MG.rainCss(w.rain)}" rx="1"/>`;
      });
      svg += `<line class="grid" x1="${CH.L}" x2="${W - CH.R}" y1="${T + ph}" y2="${T + ph}"/>`;
      return svg + cursorSvg((i) => X(st.steps[i].t)) + '</svg>';
    }

    // Temperatura: una línea con su área, entre el mínimo y el máximo redondeados.
    function tempChartHtml(ser) {
      const n = ser.length;
      const { W, H, T } = CH;
      const ph = H - T - CH.B;
      const X = chartX();
      const x = (i) => X(st.steps[i].t);
      const t0 = st.steps[0].t, tN = st.steps[n - 1].t;
      const vals = ser.filter(Boolean).map((w) => tval(w.temp));
      let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
      if (hi - lo < 8) { lo = Math.floor((lo + hi) / 2 - 4); hi = lo + 8; }
      const y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
      let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('viento.temp.chart'))}">`;
      for (const f of [0, 0.5, 1]) svg += `<line class="grid" x1="${CH.L}" x2="${W - CH.R}" y1="${(T + ph * f).toFixed(1)}" y2="${(T + ph * f).toFixed(1)}"/>`;
      svg += `<text class="axis" x="${CH.L}" y="${T - 4}">${hi} ${tunit()}</text>`;
      svg += `<text class="axis" x="${CH.L}" y="${T + ph - 3}">${lo}°</text>`;
      const zero = mph() ? 32 : 0; // la línea del hielo
      if (zero > lo && zero < hi) svg += `<line class="grid zero" x1="${CH.L}" x2="${W - CH.R}" y1="${y(zero).toFixed(1)}" y2="${y(zero).toFixed(1)}"/>`;
      svg += axisSvg(X, t0, tN);
      for (const [i, j] of runs(ser)) {
        const line = ser.slice(i, j + 1).map((w, k) => `${k ? 'L' : 'M'}${x(i + k).toFixed(1)},${y(tval(w.temp)).toFixed(1)}`).join('');
        svg += `<path class="vt-temp-area" d="${line}L${x(j).toFixed(1)},${T + ph}L${x(i).toFixed(1)},${T + ph}Z"/><path class="vt-temp" d="${line}"/>`;
      }
      svg += cursorSvg(x);
      for (const i of new Set([st.cur, st.hover !== null ? st.hover : st.cur])) if (ser[i]) svg += `<circle class="vt-dot" cx="${x(i).toFixed(1)}" cy="${y(tval(ser[i].temp)).toFixed(1)}" r="3.4"/>`;
      return svg + '</svg>';
    }
    const chartFor = (ser) => (st.tab === 'rain' ? rainChartHtml(ser) : st.tab === 'temp' ? tempChartHtml(ser) : chartHtml(ser));

    function readout(ser, i) {
      const w = ser[i], s = st.steps[i];
      if (!s) return '';
      const time = `${weekday(s.t)} ${clock(s.t)}`;
      if (!w) return `${time} · ${t('viento.loading')}`;
      if (st.tab === 'rain') return w.span > 0 ? `${time} · ${rate(isWet(w) ? w.rain : 0)} · ${spanText(w.span)}` : `${time} · ${t('viento.rain.noData')}`;
      if (st.tab === 'temp') return `${time} · ${temp(w.temp)}`;
      const dir = w.speed < 0.5 ? t('viento.calm').toLowerCase() : D.dirShort(getT(), w.from);
      return `${time} · ${speed(w.speed)} ${dir} · ${t('viento.gusts', { speed: speed(w.gust) })}`;
    }

    const modelName = () => WG.MODELS.find((m) => m.id === st.model).name;
    // Pestañas (viento, lluvia, temperatura) y selector de modelo: siempre visibles, también si un modelo no ha cargado.
    function tabsHtml() {
      return `<div class="seg vt-tabs" role="group" aria-label="${esc(t('viento.tabs'))}">
          ${TABS.map((k) => `<button type="button" data-tab="${k}" aria-pressed="${st.tab === k}">${esc(t(`viento.tab.${k}`))}</button>`).join('')}
        </div>`;
    }
    function modelsHtml() {
      return `<section class="vt-models">
          <div class="seg small" role="group" aria-label="${esc(t('viento.model'))}">
            ${WG.MODELS.map((m) => `<button type="button" data-model="${m.id}" aria-pressed="${st.model === m.id}">${esc(m.name)}</button>`).join('')}
          </div>
          <p class="hint">${esc(t('viento.m.' + st.model))}</p>
        </section>`;
    }
    const sourcesHtml = () => `<footer class="agua-sources"><p>${esc(t('viento.src.' + st.model, { day: weekday(st.index.runTime, 'long'), time: clock(st.index.runTime) }))}</p>${st.tab === 'wind' ? '' : `<p>${esc(t('viento.srcMet'))}</p>`}</footer>`;

    // Bloque de la gráfica: la de las próximas horas, la línea de lectura y, según la pestaña, lo más fuerte.
    function forecastHtml(ser) {
      const ready = ser.filter(Boolean).length;
      const partial = ready < ser.length;
      const hours = Math.round((st.steps[st.steps.length - 1].t - st.steps[0].t) / HOUR);
      const keys = st.tab === 'wind' ? `<div class="keys"><span class="key key-wind">${esc(t('viento.keyWind'))}</span><span class="key key-gust">${esc(t('viento.keyGust'))}</span></div>` : '';
      let max = '';
      if (st.tab === 'wind') {
        let best = -1;
        ser.forEach((v, i) => { if (v && (best < 0 || v.gust > ser[best].gust)) best = i; });
        if (best >= 0) max = `<p class="vt-max">${esc(t('viento.max', { speed: speed(ser[best].gust), when: when(st.steps[best].t) }))}${partial ? ` <span class="hint">${esc(t('viento.partial'))}</span>` : ''}</p>`;
      } else {
        if (st.tab === 'rain') {
          let best = -1;
          ser.forEach((v, i) => { if (v && v.span > 0 && isWet(v) && (best < 0 || v.rain > ser[best].rain)) best = i; });
          if (best >= 0) max = `<p class="vt-max">${esc(t(ser[best].span === 1 ? 'viento.rain.max1' : 'viento.rain.maxN', { rate: rate(ser[best].rain), n: ser[best].span, when: when(st.steps[best].t) }))}</p>`;
        }
        if (partial) max += `<p class="hint vt-partial">${esc(t('viento.partial'))}</p>`;
      }
      return `<section class="block vt-forecast">
            <div class="block-head"><h2>${esc(t('viento.next', { n: hours }))}</h2>${keys}</div>
            <div class="chart vt-chart">${chartFor(ser)}</div>
            <p class="vt-readout">${esc(readout(ser, st.hover !== null ? st.hover : st.cur))}</p>
            ${max}
          </section>`;
    }

    function render() {
      if (!st.open) return;
      const el = dom.panel;
      const top = tabsHtml() + modelsHtml();
      if (!st.index) {
        el.innerHTML = top + `<p class="hint agua-msg">${esc(st.error ? t('viento.error', { model: modelName() }) : t('viento.loading'))}</p>`;
        return;
      }
      if (!st.steps.length) {
        el.innerHTML = top + `<p class="hint agua-msg">${esc(t('viento.noMet'))}</p>` + sourcesHtml();
        return;
      }
      const p = place();
      const s = step();
      let html = top;
      if (!p) {
        html += `<section class="vt-now"><p class="hint">${esc(t('viento.pickHint'))}</p></section>`;
      } else {
        const ser = series(p);
        html += `<section class="vt-now">${nowHtml(p, ser, s)}</section>`;
        if (st.tab === 'temp' && ser.some(Boolean)) html += daysHtml(ser);
        if (ser.some(Boolean)) html += forecastHtml(ser);
        if (!p.picked) html += `<p class="hint vt-pick-hint">${esc(t('viento.pickHint'))}</p>`;
      }
      if (st.tab === 'wind') {
        html += `<section class="block vt-controls">
          <div class="seg" role="group" aria-label="${esc(t('viento.colorBy'))}">
            <button type="button" data-field="speed" aria-pressed="${st.field === 'speed'}">${esc(t('viento.keyWind'))}</button>
            <button type="button" data-field="gust" aria-pressed="${st.field === 'gust'}">${esc(t('viento.keyGust'))}</button>
          </div>
          <label class="switch-row"><input type="checkbox" data-particles ${st.particles ? 'checked' : ''}> <span>${esc(t('viento.particles'))}</span></label>
        </section>`;
      }
      el.innerHTML = html + sourcesHtml();
    }

    // Eventos del panel (delegados: el contenido se rehace a menudo).
    dom.panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && b.dataset.tab) { setTab(b.dataset.tab); return; }
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
      let best = 0;
      if (st.tab === 'rain') {
        // La barra sobre la que está el puntero (o la más cercana).
        const X = chartX(st.steps[0].t - (st.steps[0].span || 0) * HOUR);
        let dist = Infinity;
        st.steps.forEach((s, i) => {
          const a = X(s.t - (s.span || 0) * HOUR), b = X(s.t);
          const d = px >= a && px <= b ? 0 : Math.min(Math.abs(px - a), Math.abs(px - b));
          if (d < dist) { dist = d; best = i; }
        });
        return best;
      }
      const X = chartX();
      st.steps.forEach((s, i) => { if (Math.abs(X(s.t) - px) < Math.abs(X(st.steps[best].t) - px)) best = i; });
      return best;
    }
    // Solo la gráfica y la línea de lectura: rehacer todo el panel con cada movimiento del ratón sobra.
    function hoverRender() {
      const p = place();
      const chart = dom.panel.querySelector('.vt-chart');
      if (!p || !chart) return;
      const ser = series(p);
      chart.innerHTML = chartFor(ser);
      const ro = dom.panel.querySelector('.vt-readout');
      if (ro) ro.textContent = readout(ser, st.hover !== null ? st.hover : st.cur);
    }

    dom.tl.play.addEventListener('click', toggle);
    dom.tl.prev.addEventListener('click', () => { pause(); stepBy(-1); });
    dom.tl.next.addEventListener('click', () => { pause(); stepBy(1); });

    // Otra pestaña (viento, lluvia o temperatura): se mantienen la hora (la más cercana), el modelo y el punto.
    function setTab(tab) {
      if (tab === st.tab || !TABS.includes(tab)) return;
      try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* almacenamiento bloqueado */ }
      const keep = step() && step().t;
      pause();
      st.tab = tab;
      st.hover = null;
      if (st.index) pickSteps(keep); // a la lluvia y la temperatura les pueden faltar horas
      setAttribution(attribution());
      stopParticles();
      P.n = 0;
      repaintColor();
      renderLegend();
      renderTimeline();
      render();
      updateMarker();
      if (st.index && st.steps.length) { goTo(st.cur); prefetch(); }
    }

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
      setAttribution(attribution());
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
      setAttribution(attribution());
      st.prevView = { center: map.getCenter(), zoom: map.getZoom() };
      if (map.getZoom() > MAX_ZOOM) map.setZoom(MAX_ZOOM, { animate: false });
      colorLayer.addTo(map);
      repaintColor();
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
        setAttribution(attribution());
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
