// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/* Agua en España: reserva de los embalses y lluvia por cuenca hidrográfica.
 * Panel lateral, capa de cuencas y puntos de los embalses en el mapa, y la
 * ficha de cada embalse, y los pluviómetros de AEMET. Canarias (fuera del
 * radar) tiene su propia vista, y su lluvia sale de los pluviómetros. Los datos (agua.json,
 * pluvio.json y el histórico de cada cuenca, embalses/<id>.json) los publica
 * la web cada hora; aquí solo se muestran.
 * La ubicación y los datos de cada presa vienen de shared/embalses.js; las cuentas
 * sobre la historia larga de cada pluviómetro (años, normales, quintiles), de shared/clima.js. */
(function () {
  'use strict';
  const L = window.L;
  const CU = window.RA_CUENCAS;
  const CL = window.RA_CLIMA;
  const EM = () => window.RA_EMBALSES || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SPAIN = [[35.2, -9.4], [43.9, 4.4]]; // con Ceuta y Melilla
  const CANARIAS = [[27.5, -18.5], [29.45, -13.2]];
  const ZONES = { peninsula: SPAIN, canarias: CANARIAS };
  const PERIODS = ['h24', 'd7', 'd30', 'year'];
  // Reserva (%): de cálido (poca agua) a azul (mucha).
  const RESERVE = { steps: [25, 40, 55, 70, 85], colors: ['#d7301f', '#fc8d59', '#fdcc8a', '#91bfdb', '#4575b4', '#313695'] };
  // Lluvia (mm): umbrales según el periodo.
  const RAIN_STEPS = { h24: [1, 5, 10, 20, 40], d7: [5, 15, 30, 60, 100], d30: [20, 50, 100, 150, 250], year: [25, 75, 150, 300, 600] };
  const RAIN_COLORS = ['#e3edf3', '#b3d4ea', '#6baed6', '#3182bd', '#08519c', '#08306b'];
  const NO_DATA = '#9aa5ad';

  const classOf = (v, steps) => { let i = 0; while (i < steps.length && v >= steps[i]) i++; return i; };
  const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const resKey = (id, name) => `${id}|${name}`;

  function create({ map, api, dom, getT, getUnits, setAttribution = () => {} }) {
    const st = {
      open: false, data: null, loadedAt: 0, error: null, loading: null,
      color: 'reserve', period: 'd7', selected: null, prevView: null,
      layer: L.layerGroup(), shapes: new Map(),
      res: null, hist: new Map(), points: new Map(), pointLayer: L.layerGroup(), query: '',
      pluvio: null, gauges: new Map(), gaugeLayer: L.layerGroup(),
      gauge: null, gaugeFiles: new Map(), gaugeVar: 'rain', rainView: 'surface', surface: null,
      gOpen: new Map(), gv: null, charts: new Map()
    };
    map.createPane('agua').style.zIndex = 330;
    map.createPane('aguapoints').style.zIndex = 335;
    map.createPane('aguagauges').style.zIndex = 336;
    map.createPane('aguasurface').style.zIndex = 332;
    // Al acercarse vuelven los nombres del mapa base (ver styles.css).
    const onZoom = () => {
      if (!st.open) return;
      map.getContainer().classList.toggle('agua-near', map.getZoom() >= NEAR_ZOOM);
      for (const id of st.shapes.keys()) restyle(id);
    };
    map.on('zoomend', onZoom);
    if (window.RA_SURFACE) {
      st.surface = window.RA_SURFACE.createLayer(L, { pane: 'aguasurface', opacity: 0.78, cellPx: 3, radiusKm: 45, mask: CU.basins.flatMap((b) => b.polygons), color: () => null });
    }
    const labelsPane = map.createPane('agualabels');
    labelsPane.style.zIndex = 340;
    labelsPane.style.pointerEvents = 'none';

    const t = (k, v) => getT()(k, v);
    const locale = () => (getT().lang === 'es' ? 'es-ES' : 'en-GB');
    const num = (v, d = 0) => (v === null || v === undefined ? '—' : v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }));
    const pct = (v) => (v === null || v === undefined ? '—' : `${num(v, 1)}\u00a0%`);
    const inches = () => getUnits().rate === 'in';
    const rain = (mm) => {
      if (mm === null || mm === undefined) return '—';
      if (inches()) return `${num(mm / 25.4, 2)}\u00a0in`;
      return `${num(mm, mm < 10 ? 1 : 0)}\u00a0mm`;
    };
    const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), 1);
    const dateText = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
    const monthYear = (iso) => new Date(iso.slice(0, 7) + '-15T12:00:00Z').toLocaleDateString(locale(), { month: 'short', year: 'numeric' });
    const basinName = (b) => (getT().lang === 'es' ? b.name : b.nameEn);

    // «Península / Canarias»: salto rápido entre las dos vistas del mapa (Canarias queda lejos).
    const zoneEl = document.createElement('div');
    zoneEl.className = 'seg small agua-zone';
    zoneEl.setAttribute('role', 'group');
    zoneEl.hidden = true;
    map.getContainer().parentNode.appendChild(zoneEl);
    const zoneNow = () => { const c = map.getCenter(); return c.lat < 31.5 && c.lng < -12 ? 'canarias' : 'peninsula'; };
    function renderZone(now = zoneNow()) {
      zoneEl.setAttribute('aria-label', t('agua.zone'));
      zoneEl.innerHTML = Object.keys(ZONES).map((z) => `<button type="button" data-zone="${z}" aria-pressed="${now === z}">${esc(t('agua.zone.' + z))}</button>`).join('');
    }
    zoneEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-zone]');
      if (!b) return;
      renderZone(b.dataset.zone);
      map.fitBounds(ZONES[b.dataset.zone], { padding: [10, 10] });
    });
    map.on('moveend', () => { if (st.open) renderZone(); });

    // CC BY 4.0 (OPERA, AEMA) y aviso legal de MITECO: citar la fuente.
    const attribution = () => [
      `${esc(t('agua.attrReservoirs'))} <a href="https://www.miteco.gob.es/es/agua/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico.html">MITECO</a>`,
      `${esc(t('agua.attrRain'))} <a href="https://www.eumetnet.eu/">EUMETNET</a> OPERA (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, ${esc(t('map.processed'))})`,
      `${esc(t('agua.attrBasins'))} <a href="https://www.eea.europa.eu/">AEMA</a> (CC BY 4.0)`,
      // Nota legal de AEMET: citarla como fuente («© AEMET»).
      ...(st.pluvio || gaugeBasins() ? [`${esc(t('agua.attrGauges'))} © <a href="https://www.aemet.es/">AEMET</a>`] : [])
    ].join(' · ');

    // ----------------------------------------------------------------
    // Datos

    async function load(force) {
      if (st.loading) return st.loading;
      if (!force && st.data && Date.now() - st.loadedAt < 10 * 60000) return st.data;
      // Los pluviómetros son aparte: si fallan, el resto sigue.
      const pluvio = api.agua('pluvio.json').then((p) => { st.pluvio = p; }).catch(() => {});
      st.loading = Promise.all([api.agua(), pluvio]).then(([d]) => {
        st.data = d; st.loadedAt = Date.now(); st.error = null;
        setAttribution(attribution());
        return d;
      }).catch((e) => { st.error = e.message || String(e); return st.data; })
        .finally(() => { st.loading = null; });
      return st.loading;
    }

    const res = (id) => (st.data && st.data.reservoirs && st.data.reservoirs.basins[id]) || null;
    const rainOf = (id) => (st.data && st.data.rain && st.data.rain.basins[id]) || null;
    // Cuencas cuya lluvia sale de los pluviómetros (Canarias, fuera del radar).
    const gaugeBasins = () => !!(st.data && st.data.rain && Object.values(st.data.rain.basins).some((x) => x.source === 'gauges'));
    const resRow = (id, name) => { const r = res(id); return (r && r.list && r.list.find((x) => x.name === name)) || null; };
    const resPct = (x) => (x && x.cap ? (100 * x.vol) / x.cap : null);
    const inv = (id, name) => { const e = EM(); return (e && e.items[resKey(id, name)]) || null; };

    // Histórico de los embalses de una cuenca (se pide al abrir la cuenca o un embalse).
    function loadHist(id) {
      const h = st.hist.get(id);
      if (h && (h.loading || (h.data && Date.now() - h.at < 30 * 60000))) return h.loading || Promise.resolve(h.data);
      const entry = { at: Date.now(), data: h ? h.data : null, loading: null, error: null };
      entry.loading = api.agua(`embalses/${id}.json`).then((d) => { entry.data = d; return d; })
        .catch((e) => { entry.error = e.message || String(e); return entry.data; })
        .finally(() => { entry.loading = null; });
      st.hist.set(id, entry);
      return entry.loading;
    }
    const histOf = (id) => { const h = st.hist.get(id); return h ? h.data : null; };

    function valueOf(id) {
      if (st.color === 'reserve') { const r = res(id); return r ? r.pct : null; }
      const r = rainOf(id);
      return r ? r[st.period] : null;
    }
    function colorOf(v) {
      if (v === null || v === undefined) return NO_DATA;
      return st.color === 'reserve' ? RESERVE.colors[classOf(v, RESERVE.steps)] : RAIN_COLORS[classOf(v, RAIN_STEPS[st.period])];
    }
    const NEAR_ZOOM = 8;
    const labelOf = (v) => (v === null || v === undefined ? '' : st.color === 'reserve' ? `${num(v, 0)} %` : rain(v));

    // ----------------------------------------------------------------
    // Mapa

    function buildLayer() {
      if (st.shapes.size) return;
      for (const b of CU.basins) {
        const latlngs = b.polygons.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => [lat, lon])));
        const shape = L.polygon(latlngs, { pane: 'agua', weight: 1, color: '#ffffff', opacity: 0.9, fillOpacity: 0.72, bubblingMouseEvents: false });
        shape.on('click', () => select(b.id));
        shape.on('mouseover', () => shape.setStyle({ weight: st.selected === b.id ? 3 : 2 }));
        shape.on('mouseout', () => restyle(b.id));
        // Etiqueta en el polígono más grande.
        const big = b.polygons.reduce((m, p) => (p[0].length > m[0].length ? p : m), b.polygons[0]);
        const center = L.polygon(big[0].map(([lon, lat]) => [lat, lon])).getBounds().getCenter();
        const label = L.tooltip({ permanent: true, direction: 'center', className: 'agua-label', pane: 'agualabels', interactive: false }).setLatLng(center);
        st.shapes.set(b.id, { shape, label, center });
        shape.addTo(st.layer);
      }
    }

    function restyle(id) {
      const s = st.shapes.get(id);
      if (!s) return;
      const v = valueOf(id);
      const sel = st.selected === id;
      // De cerca, las cuencas casi transparentes: que se vean los embalses y los ríos.
      const near = map.getZoom() >= NEAR_ZOOM;
      const surface = surfaceOn();
      s.shape.setStyle({ fillColor: colorOf(v), weight: sel ? 3 : 1, color: sel ? '#14212b' : surface ? '#7d8a94' : '#ffffff', fillOpacity: surface ? 0 : v === null || v === undefined ? 0.25 : near ? 0.22 : 0.72 });
      if (sel) s.shape.bringToFront();
      const text = surfaceOn() ? '' : labelOf(v);
      s.label.setContent(text);
      if (text && st.open) s.label.addTo(map); else s.label.remove();
    }
    function restyleAll() { for (const id of st.shapes.keys()) restyle(id); restylePoints(); renderLegend(); }

    // Embalses: un punto en la presa, del tamaño de su capacidad.
    function buildPoints() {
      const e = EM();
      st.pointLayer.clearLayers();
      st.points.clear();
      if (!e || !st.data || !st.data.reservoirs) return;
      const all = [];
      for (const [id, b] of Object.entries(st.data.reservoirs.basins)) for (const x of b.list || []) { const it = e.items[resKey(id, x.name)]; if (it) all.push({ id, x, it }); }
      all.sort((a, b) => b.x.cap - a.x.cap); // los pequeños encima
      for (const { id, x, it } of all) {
        const m = L.circleMarker([it.lat, it.lon], { pane: 'aguapoints', radius: 2.5 + Math.sqrt(x.cap) / 4.5, weight: 1, color: '#ffffff', fillOpacity: 0.95, bubblingMouseEvents: false });
        m.bindTooltip(() => `${esc(x.name)} · ${num(resPct(x), 0)} %`, { direction: 'top', className: 'agua-tip', offset: [0, -4] });
        m.on('click', () => openRes(id, x.name, false));
        st.points.set(resKey(id, x.name), { m, x });
        m.addTo(st.pointLayer);
      }
    }

    // Pluviómetros: [id, nombre, lat, lon, 1 h, 24 h, 7 días, 30 días, desde el 1 oct, temperatura].
    const GAUGE_COL = { h24: 5, d7: 6, d30: 7, year: 8 };
    const surfaceOn = () => st.open && st.color === 'rain' && st.rainView === 'surface' && !!st.surface;
    const gaugeValue = (g) => (GAUGE_COL[st.period] ? g[GAUGE_COL[st.period]] : null);
    const gaugeRows = () => (st.pluvio && st.pluvio.stations) || [];
    // Si los periodos de varios días terminan antes de la última hora (faltan horas
    // entre el último día publicado por AEMET y las guardadas), hasta qué día llegan.
    const gaugeLag = () => {
      const p = st.pluvio;
      if (!p || !p.periodsUntil || !GAUGE_COL[st.period] || st.period === 'h24') return null;
      return Date.parse(p.until) - Date.parse(p.periodsUntil) > 3 * 3600000 ? dateText(new Date(Date.parse(p.periodsUntil) - 8 * 3600000).toISOString().slice(0, 10)) : null;
    };

    function buildGauges() {
      st.gaugeLayer.clearLayers();
      st.gauges.clear();
      for (const g of gaugeRows()) {
        const m = L.circleMarker([g[2], g[3]], { pane: 'aguagauges', radius: 4.5, weight: 1, color: '#14212b', opacity: 0.55, fillOpacity: 0.95, bubblingMouseEvents: false });
        m.bindTooltip(() => {
          const v = gaugeValue(g);
          return `<strong>${esc(g[1])}</strong><br>${v !== null ? `${esc(t('agua.p.' + st.period))}: ${esc(rain(v))} · ` : ''}${esc(t('agua.gaugesLastHour'))}: ${esc(rain(g[4]))}${g[9] !== null && g[9] !== undefined ? ` · ${esc(tempTxt(g[9]))}` : ''}`;
        }, { direction: 'top', className: 'agua-tip', offset: [0, -4] });
        m.on('click', () => openGauge(g[0], false));
        st.gauges.set(g[0], { m, g });
      }
    }

    // Superficie interpolada entre pluviómetros (surface.js), con la escala de lluvia continua.
    function rainRamp(v) {
      if (!(v >= 0.1)) return null;
      const steps = RAIN_STEPS[st.period];
      const stops = [0.1, ...steps];
      const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      let i = 0;
      while (i < stops.length - 1 && v >= stops[i + 1]) i++;
      if (i >= stops.length - 1) return [...rgb(RAIN_COLORS[RAIN_COLORS.length - 1]), 255];
      const f = (v - stops[i]) / (stops[i + 1] - stops[i]);
      const a = rgb(RAIN_COLORS[i]), b = rgb(RAIN_COLORS[i + 1]);
      return [0, 1, 2].map((k) => Math.round(a[k] + f * (b[k] - a[k]))).concat(255);
    }
    function updateSurface() {
      if (!st.surface) return;
      if (!surfaceOn()) { map.removeLayer(st.surface); return; }
      const pts = [];
      for (const g of gaugeRows()) { const v = gaugeValue(g); if (v !== null && v !== undefined) pts.push({ lat: g[2], lon: g[3], v }); }
      st.surface.setColor(rainRamp).setPoints(pts);
      if (!map.hasLayer(st.surface)) st.surface.addTo(map); else st.surface.redraw();
    }

    // En «Lluvia», los pluviómetros; en «Reserva», los embalses.
    function restyleGauges() {
      const show = st.open && st.color === 'rain';
      if (show) { map.removeLayer(st.pointLayer); st.gaugeLayer.addTo(map); } else { map.removeLayer(st.gaugeLayer); if (st.open) st.pointLayer.addTo(map); }
      const steps = RAIN_STEPS[st.period];
      for (const { m, g } of st.gauges.values()) {
        if (!show) { st.gaugeLayer.removeLayer(m); continue; }
        // Sin dato del periodo (p. ej. aún no hay 7 días guardados): punto gris pequeño.
        const v = gaugeValue(g);
        const none = v === null || v === undefined;
        const sel = st.gauge === g[0];
        m.setStyle({ fillColor: none ? NO_DATA : RAIN_COLORS[classOf(v, steps)], fillOpacity: none ? 0.7 : 0.95, weight: sel ? 3 : 1, opacity: sel ? 1 : 0.55 });
        m.setRadius(sel ? 7 : none ? 3 : 4.5);
        st.gaugeLayer.addLayer(m);
        if (sel) m.bringToFront();
      }
      updateSurface();
    }

    function restylePoints() {
      restyleGauges();
      const sel = st.res ? resKey(st.res.id, st.res.name) : null;
      const reserve = st.color === 'reserve';
      for (const [k, { m, x }] of st.points) {
        const on = k === sel;
        m.setStyle({
          fillColor: reserve ? RESERVE.colors[classOf(resPct(x), RESERVE.steps)] : '#ffffff',
          color: on || !reserve ? '#14212b' : '#ffffff', weight: on ? 3 : 1
        });
        if (on) m.bringToFront();
      }
    }

    function renderLegend() {
      const steps = st.color === 'reserve' ? RESERVE.steps : RAIN_STEPS[st.period];
      const colors = st.color === 'reserve' ? RESERVE.colors : RAIN_COLORS;
      const fmt = st.color === 'reserve' ? (v) => `${v}` : (v) => (inches() ? num(v / 25.4, 1) : `${v}`);
      const unit = st.color === 'reserve' ? '%' : inches() ? 'in' : 'mm';
      let html = `<div class="agua-legend-title">${esc(st.color === 'reserve' ? t('agua.legendReserve') : t('agua.legendRain', { period: t('agua.p.' + st.period) }))}</div><div class="agua-legend-bar">`;
      colors.forEach((c, i) => { html += `<span style="background:${c}"></span>`; });
      html += '</div><div class="agua-legend-scale">';
      steps.forEach((v) => { html += `<span>${fmt(v)}</span>`; });
      html += `<span class="unit">${unit}</span></div>`;
      const lag = st.color === 'rain' && gaugeLag();
      if (lag) html += `<div class="agua-legend-note">${esc(t('agua.legendLag', { date: lag }))}</div>`;
      if (st.color === 'reserve') html += `<div class="agua-legend-note">${esc(t('agua.legendNoReserve'))}</div>`;
      dom.legend.innerHTML = html;
    }

    // ----------------------------------------------------------------
    // Panel

    function chartLine(canvas, values, avg, labels, opts = {}) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300, h = canvas.clientHeight || 90;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const ink = css.getPropertyValue('--muted').trim() || '#576875';
      const line = css.getPropertyValue('--line').trim() || '#d6dee4';
      const accent = css.getPropertyValue('--accent').trim() || '#0077aa';
      const pad = { l: 26, r: 6, t: 6, b: 16 };
      const all = values.concat(avg || []).filter((v) => v !== null && v !== undefined);
      if (!all.length) return;
      const lo = opts.fixed ? 0 : Math.max(0, Math.floor((Math.min(...all) - 5) / 10) * 10);
      const hi = opts.fixed ? 100 : Math.min(100, Math.ceil((Math.max(...all) + 5) / 10) * 10);
      const x = (i) => pad.l + (i / Math.max(1, values.length - 1)) * (w - pad.l - pad.r);
      const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
      ctx.font = '10px ' + (css.getPropertyValue('--font') || 'sans-serif');
      ctx.fillStyle = ink; ctx.strokeStyle = line; ctx.lineWidth = 1;
      for (const v of [lo, (lo + hi) / 2, hi]) {
        ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
        ctx.fillText(`${Math.round(v)}%`, 0, y(v) + 3);
      }
      const draw = (vals, color, width, dash) => {
        ctx.beginPath(); ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = width;
        let started = false;
        vals.forEach((v, i) => { if (v === null || v === undefined) { started = false; return; } if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v)); });
        ctx.stroke(); ctx.setLineDash([]);
      };
      // Banda entre mínimo y máximo (por tramos sin huecos).
      if (opts.band) {
        const [bl, bh] = opts.band;
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.18;
        let run = [];
        const flush = () => {
          if (run.length > 1) {
            ctx.beginPath();
            run.forEach((i, k) => (k ? ctx.lineTo(x(i), y(bh[i])) : ctx.moveTo(x(i), y(bh[i]))));
            for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(x(run[k]), y(bl[run[k]]));
            ctx.closePath(); ctx.fill();
          }
          run = [];
        };
        values.forEach((_, i) => { if (bl[i] === null || bh[i] === null || bl[i] === undefined || bh[i] === undefined) flush(); else run.push(i); });
        flush();
        ctx.globalAlpha = 1;
      }
      if (avg) draw(avg, ink, 1.2, [3, 3]);
      draw(values, accent, opts.thin ? 1.4 : 2);
      if (labels) {
        ctx.fillStyle = ink;
        ctx.fillText(labels[0], pad.l, h - 3);
        const tw = ctx.measureText(labels[1]).width;
        ctx.fillText(labels[1], w - pad.r - tw, h - 3);
      }
    }

    // Esta misma semana en cada año (%), el último resaltado.
    function chartYears(canvas, values, first) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300, h = canvas.clientHeight || 70;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const ink = css.getPropertyValue('--muted').trim() || '#576875';
      const line = css.getPropertyValue('--line').trim() || '#d6dee4';
      const accent = css.getPropertyValue('--accent').trim() || '#0077aa';
      const pad = { l: 26, r: 6, t: 6, b: 16 };
      const y = (v) => pad.t + (1 - v / 100) * (h - pad.t - pad.b);
      ctx.font = '10px ' + (css.getPropertyValue('--font') || 'sans-serif');
      ctx.fillStyle = ink; ctx.strokeStyle = line; ctx.lineWidth = 1;
      for (const v of [0, 50, 100]) { ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke(); ctx.fillText(`${v}%`, 0, y(v) + 3); }
      const bw = (w - pad.l - pad.r) / values.length;
      values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        const last = i === values.length - 1;
        ctx.fillStyle = last ? accent : ink;
        ctx.globalAlpha = last ? 1 : 0.45;
        ctx.fillRect(pad.l + i * bw + (bw > 4 ? 0.5 : 0), y(Math.min(100, v)), Math.max(1, bw - (bw > 4 ? 1 : 0)), y(0) - y(Math.min(100, v)));
      });
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink;
      ctx.fillText(String(first), pad.l, h - 3);
      const end = String(first + values.length - 1);
      ctx.fillText(end, w - pad.r - ctx.measureText(end).width, h - 3);
    }

    function chartBars(canvas, values) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300, h = canvas.clientHeight || 70;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const ink = css.getPropertyValue('--muted').trim() || '#576875';
      const accent = css.getPropertyValue('--accent').trim() || '#0077aa';
      const pad = { l: 40, r: 6, t: 6, b: 4 };
      const max = Math.max(5, ...values.filter((v) => v !== null));
      const bw = (w - pad.l - pad.r) / values.length;
      ctx.font = '10px ' + (css.getPropertyValue('--font') || 'sans-serif');
      ctx.fillStyle = ink;
      ctx.fillText(inches() ? `${num(max / 25.4, 1)} in` : `${Math.round(max)} mm`, 0, pad.t + 8);
      values.forEach((v, i) => {
        if (v === null) { ctx.fillStyle = 'rgba(128,128,128,0.25)'; ctx.fillRect(pad.l + i * bw + 1, h - pad.b - 2, bw - 2, 2); return; }
        const bh = (v / max) * (h - pad.t - pad.b);
        ctx.fillStyle = i === values.length - 1 ? ink : accent;
        ctx.fillRect(pad.l + i * bw + 1, h - pad.b - bh, Math.max(1, bw - 2), bh);
      });
    }

    function renderGauges() {
      const rows = gaugeRows();
      if (!rows.length) return '';
      const col = GAUGE_COL[st.period];
      const withValue = col ? rows.filter((g) => g[col] !== null) : [];
      const raining = rows.filter((g) => g[4] > 0).length;
      let html = `<h3>${esc(t('agua.gauges'))}</h3>
        <p class="agua-deltas">${esc(raining ? t('agua.gaugesNow', { n: raining, total: rows.length }) : t('agua.gaugesDry', { total: rows.length }))}</p>`;
      // Hasta tener datos del periodo, la última hora.
      const lag = gaugeLag();
      if (lag && withValue.length) html += `<p class="hint">${esc(t('agua.gaugesLag', { period: t('agua.p.' + st.period), date: lag }))}</p>`;
      let list = withValue, key = col, title = t('agua.gaugesTop', { period: t('agua.p.' + st.period) });
      if (!list.length) { list = rows; key = 4; title = t('agua.gaugesTop', { period: t('agua.gaugesLastHour').toLowerCase() }); html += `<p class="hint">${esc(t('agua.gaugesWaiting', { period: t('agua.p.' + st.period) }))}</p>`; }
      else if (withValue.length < rows.length * 0.8) html += `<p class="hint">${esc(t('agua.gaugesSome', { n: withValue.length, total: rows.length }))}</p>`;
      const top = list.filter((g) => g[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 8);
      if (top.length) {
        html += `<p class="agua-subtitle">${esc(title)}</p><ol class="agua-gauges">${top.map((g) => `<li><button type="button" data-gauge="${esc(g[0])}"><span>${esc(g[1])}</span><span class="val">${esc(rain(g[key]))}</span></button></li>`).join('')}</ol>`;
      }
      html += `<p class="hint">${esc(t('agua.gaugesUntil', { time: new Date(st.pluvio.until).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }))}</p>`;
      return html;
    }

    function renderTotal() {
      const r = st.data && st.data.reservoirs;
      if (!r) return `<p class="hint">${esc(t('agua.noReservoirs'))}</p>`;
      const tt = r.total;
      const d = tt.prevPct !== null ? t('agua.weekChange', { d: signed(tt.pct - tt.prevPct) }) : '';
      return `<div class="agua-big">${num(tt.pct, 1)}<span> %</span></div>
        <p class="agua-line">${esc(t('agua.ofCapacity', { vol: num(tt.vol), cap: num(tt.cap) }))}</p>
        <p class="agua-deltas">${esc([d, tt.lastYearPct !== null ? t('agua.lastYear', { pct: pct(tt.lastYearPct) }) : '', tt.avg10Pct !== null ? t('agua.avg10', { pct: pct(tt.avg10Pct) }) : ''].filter(Boolean).join(' · '))}</p>
        ${tt.weeks ? '<canvas class="agua-chart" data-chart="total"></canvas>' : ''}
        <p class="hint">${esc(t('agua.bulletin', { date: dateText(r.date) }))}</p>`;
    }

    function renderList() {
      const rows = CU.basins.map((b) => ({ b, r: res(b.id), rn: rainOf(b.id) }));
      let html = '';
      for (const { b, r, rn } of rows) {
        const v = r ? r.pct : null;
        const sel = st.selected === b.id ? ' selected' : '';
        html += `<li><button type="button" class="agua-row${sel}" data-id="${b.id}" aria-pressed="${!!sel}">
          <span class="dot" style="background:${colorOf(valueOf(b.id))}"></span>
          <span class="name">${esc(basinName(b))}</span>
          <span class="bar" aria-hidden="true">${v !== null ? `<span style="width:${Math.min(100, v)}%"></span>` : ''}</span>
          <span class="val">${v !== null ? `${num(v, 0)} %` : '—'}</span>
          <span class="rain">${rn ? esc(rain(rn[st.period])) : '—'}</span>
        </button></li>`;
      }
      return html;
    }

    function renderDetail(id) {
      const b = CU.basins.find((x) => x.id === id);
      if (!b) return '';
      const r = res(id), rn = rainOf(id);
      let html = `<div class="agua-detail-head"><h2>${esc(basinName(b))}</h2><button type="button" class="icon-btn" data-close aria-label="${esc(t('ui.close'))}" title="${esc(t('ui.close'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`;
      html += `<p class="hint">${esc(t('agua.area', { km2: num(b.areaKm2) }))}</p>`;
      if (r) {
        const d = r.prevPct !== null ? t('agua.weekChange', { d: signed(r.pct - r.prevPct) }) : '';
        html += `<h3>${esc(t('agua.reservoirs'))}</h3>
          <p class="agua-line"><strong>${pct(r.pct)}</strong> · ${esc(t('agua.ofCapacity', { vol: num(r.vol), cap: num(r.cap) }))}</p>
          <p class="agua-deltas">${esc([d, r.lastYearPct !== null ? t('agua.lastYear', { pct: pct(r.lastYearPct) }) : '', r.avg10Pct !== null ? t('agua.avg10', { pct: pct(r.avg10Pct) }) : ''].filter(Boolean).join(' · '))}</p>
          ${r.weeks ? '<canvas class="agua-chart" data-chart="basin"></canvas>' : ''}`;
        const hb = histOf(id);
        if (hb && hb.total && hb.total.m.length > 24) {
          html += `<h3>${esc(t('agua.since', { y: hb.total.m0.slice(0, 4) }))}</h3><canvas class="agua-chart" data-chart="basin-months"></canvas>`;
        }
      } else if (b.ambitos.length === 0) {
        html += `<p class="hint">${esc(t('agua.noBulletin'))}</p>`;
      }
      if (rn) {
        const fallen = rn.d7 !== null ? Math.round((rn.d7 * b.areaKm2) / 1000) : null;
        const gauged = rn.source === 'gauges';
        html += `<h3>${esc(t(gauged ? 'agua.rainGauges' : 'agua.rain'))}</h3>
          <dl class="agua-rain">
            ${PERIODS.map((p) => `<div><dt>${esc(t('agua.p.' + p))}</dt><dd>${esc(rain(rn[p]))}</dd></div>`).join('')}
          </dl>
          ${gauged ? `<p class="hint">${esc(t(rn.n === 1 ? 'agua.gaugeBasis1' : 'agua.gaugeBasis', { n: rn.n }))}${rn.until ? ' ' + esc(t('agua.rainUntil', { time: new Date(rn.until).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })) : ''}</p>` : ''}
          ${fallen !== null ? `<p class="agua-deltas">${esc(t('agua.fallen', { hm3: num(fallen) }))}</p>` : ''}
          ${rn.cover !== null && rn.cover < 0.8 ? `<p class="hint">${esc(t('agua.partial', { pct: Math.round(rn.cover * 100) }))}</p>` : ''}
          ${rn.serie ? `<canvas class="agua-chart bars" data-chart="rain"></canvas><p class="hint">${esc(t('agua.daily30'))}</p>` : ''}`;
      } else if (b.radar === false) {
        html += `<h3>${esc(t('agua.rainGauges'))}</h3><p class="hint">${esc(t('agua.noGaugeRain'))}</p>`;
      }
      if (r && r.list && r.list.length) {
        html += `<h3>${esc(t('agua.list', { n: r.list.length }))}</h3><ol class="agua-res">`;
        for (const x of r.list) {
          const p = x.cap ? (100 * x.vol) / x.cap : 0;
          const dv = x.prev !== null && x.prev !== undefined ? x.vol - x.prev : null;
          html += `<li><button type="button" class="agua-res-btn" data-res="${esc(x.name)}" data-basin="${id}">
            <span class="name">${esc(x.name)}${x.elec ? ` <small>${esc(t('agua.hydro'))}</small>` : ''}</span>
            <span class="bar" aria-hidden="true"><span style="width:${Math.min(100, p)}%"></span></span>
            <span class="val">${num(p, 0)} %</span>
            <span class="vol">${num(x.vol)}/${num(x.cap)} hm³${dv ? ` <em class="${dv > 0 ? 'up' : 'down'}">${dv > 0 ? '▲' : '▼'}${num(Math.abs(dv))}</em>` : ''}</span></button></li>`;
        }
        html += '</ol>';
      }
      return html;
    }

    // Cómo está esta semana frente a la misma semana de otros años.
    function rankText(p, yrs, y0) {
      const vals = yrs.map((v, i) => ({ v, year: y0 + i })).filter((o) => o.v !== null);
      if (vals.length < 5 || p === null) return '';
      const below = vals.filter((o) => o.v < p).length;
      const now = y0 + yrs.length;
      if (below === 0) return t('agua.rankLowest', { y: vals[0].year });
      if (below === vals.length) return t('agua.rankHighest', { y: vals[0].year });
      // Más bajo (o alto) desde el último año que estuvo así.
      const lastLower = vals.filter((o) => o.v <= p).pop().year;
      const lastHigher = vals.filter((o) => o.v >= p).pop().year;
      if (now - lastLower >= 4) return t('agua.rankLowSince', { y: lastLower });
      if (now - lastHigher >= 4) return t('agua.rankHighSince', { y: lastHigher });
      return t('agua.rankMid', { k: below, n: vals.length });
    }

    function renderRes() {
      const { id, name } = st.res;
      const b = CU.basins.find((x) => x.id === id);
      const x = resRow(id, name), it = inv(id, name);
      const hb = histOf(id), H = hb && hb.res ? hb.res[name] : null;
      const he = st.hist.get(id);
      let html = `<div class="agua-res-head"><button type="button" class="icon-btn" data-res-back aria-label="${esc(t('agua.resBack'))}" title="${esc(t('agua.resBack'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button><span>${esc(b ? basinName(b) : '')}</span></div>`;
      html += `<h2 class="agua-res-name">${esc(name)}</h2>`;
      const where = [it && it.river, it && it.prov && it.prov.join(', ')].filter(Boolean).join(' · ');
      if (where) html += `<p class="hint">${esc(where)}</p>`;
      if (!x) return html + `<p class="hint">${esc(t('agua.noReservoirs'))}</p>`;
      const p = resPct(x);
      const parts = [];
      if (x.prev !== null && x.prev !== undefined && x.cap) {
        const dv = x.vol - x.prev;
        parts.push(`${t('agua.weekChange', { d: signed(p - (100 * x.prev) / x.cap) })} (${dv > 0 ? '+' : dv < 0 ? '−' : '±'}${num(Math.abs(dv))} hm³)`);
      }
      if (H) {
        const ly = H.yrs.length ? H.yrs[H.yrs.length - 1] : null;
        const a10 = H.avg.length ? H.avg[H.avg.length - 1] : null;
        if (ly !== null) parts.push(t('agua.lastYear', { pct: pct(ly) }));
        if (a10 !== null) parts.push(t('agua.avg10', { pct: pct(a10) }));
      }
      html += `<div class="agua-big">${num(p, 1)}<span> %</span></div>
        <p class="agua-line">${esc(t('agua.ofCapacity', { vol: num(x.vol), cap: num(x.cap) }))}</p>
        <p class="agua-deltas">${esc(parts.join(' · '))}</p>`;
      if (H) {
        const rank = rankText(p, H.yrs, H.y0);
        if (rank) html += `<p class="agua-rank">${esc(rank)}</p>`;
        html += `<h3>${esc(t('agua.lastYearChart'))}</h3><canvas class="agua-chart tall" data-chart="res-year"></canvas>
          <p class="hint">${esc(t('agua.lastYearLegend', { y: H.since.slice(0, 4) }))}</p>`;
        if (H.yrs.length >= 5) html += `<h3>${esc(t('agua.sameWeek'))}</h3><canvas class="agua-chart" data-chart="res-years"></canvas>`;
        if (H.m.length > 24) {
          html += `<h3>${esc(t('agua.since', { y: H.m0.slice(0, 4) }))}</h3><canvas class="agua-chart" data-chart="res-months"></canvas>
            <p class="hint">${esc(t('agua.records', { max: pct(H.max[0]), dmax: monthYear(H.max[1]), min: pct(H.min[0]), dmin: monthYear(H.min[1]) }))}</p>`;
        }
      } else {
        html += `<p class="hint">${esc(he && he.loading ? t('agua.loading') : t('agua.noHistory'))}</p>`;
      }
      if (x.elec) html += `<p class="hint">${esc(t('agua.hydroNote'))}</p>`;
      if (it) {
        const E = EM();
        const row = (k, v) => (v ? `<div><dt>${esc(t(k))}</dt><dd>${esc(v)}</dd></div>` : '');
        const typeName = (code) => { const k = `agua.type.${code}`; const v = t(k); return v === k ? E.types[code] || code : v; };
        html += `<h3>${esc(t('agua.dam'))}</h3><dl class="agua-dam">
          ${row('agua.river', it.river)}
          ${row('agua.provinces', it.prov && it.prov.join(', '))}
          ${row('agua.type', it.type && typeName(it.type))}
          ${row('agua.height', it.h ? `${num(it.h)} m` : '')}
          ${row('agua.crest', it.crest ? `${num(it.crest)} m` : '')}
          ${row('agua.surface', it.surf ? `${num(it.surf)} ha` : '')}
          ${row('agua.owner', it.owner)}
        </dl>
        ${it.system ? `<p class="hint">${esc(t('agua.system'))}</p>` : ''}
        <p class="hint">${esc(E.attribution)}.</p>`;
      }
      return html;
    }

    // ----------------------------------------------------------------
    // Ficha de un pluviómetro (pluvio/<id>.json): lluvia acumulada, comparación con lo
    // normal, última observación, gráficas de la variable elegida (por horas, días, meses
    // y años), climograma, récords, normales y descarga en CSV.

    const imperial = () => getUnits().distance === 'mi';
    const tempVal = (c) => (c === null || c === undefined ? null : imperial() ? (c * 9) / 5 + 32 : c);
    const tempTxt = (c) => (c === null || c === undefined ? '—' : `${num(tempVal(c), 1)}\u00a0°${imperial() ? 'F' : 'C'}`);
    const speedVal = (ms) => (ms === null || ms === undefined ? null : imperial() ? ms * 2.23694 : ms * 3.6);
    const speedTxt = (ms) => (ms === null || ms === undefined ? '—' : `${num(speedVal(ms), 0)}\u00a0${imperial() ? 'mph' : 'km/h'}`);
    const compass = (deg) => (deg === null || deg === undefined ? '' : t('agua.compass').split(' ')[Math.round(deg / 45) % 8]);
    const rainVal = (mm) => (mm === null || mm === undefined ? null : inches() ? mm / 25.4 : mm);
    const rainUnit = () => (inches() ? 'in' : 'mm');
    const tUnit = () => (imperial() ? '°F' : '°C');
    const sUnit = () => (imperial() ? 'mph' : 'km/h');

    // Qué se puede dibujar: cada grupo, con sus variables horarias, diarias y mensuales (history).
    const GROUPS = [
      { id: 'rain', h: ['prec'], d: ['prec'], m: ['prec'] },
      { id: 'temp', h: ['ta'], d: ['tmax', 'tmin', 'tmed'], m: ['tmean', 'tmax', 'tmin'] },
      { id: 'hum', h: ['hr'], d: ['hrMedia'], m: ['hr'] },
      { id: 'wind', h: ['vv', 'vmax'], d: ['velmedia', 'racha'], m: ['wind', 'gust'] },
      { id: 'pres', h: ['pres_nmar', 'pres'], d: ['presMax', 'presMin'] },
      { id: 'sun', h: ['inso'], d: ['sol'], m: ['sun'] },
      { id: 'soil', h: ['ts', 'tss5cm', 'tss20cm'], d: [] },
      { id: 'snow', h: ['nieve'], d: [] },
      { id: 'vis', h: ['vis'], d: [] }
    ];
    // Hay historia mensual de ese grupo.
    const hasHist = (G, id) => {
      const g = GROUPS.find((x) => x.id === id);
      return !!(g && g.m && G.history && G.history.m0 && g.m.some((k) => G.history[k] && G.history[k].some((v) => v !== null)));
    };

    function loadGauge(id) {
      const h = st.gaugeFiles.get(id);
      if (h && (h.loading || (h.data && Date.now() - h.at < 10 * 60000))) return h.loading || Promise.resolve(h.data);
      const entry = { at: Date.now(), data: h ? h.data : null, loading: null, error: null };
      entry.loading = api.agua(`pluvio/${id}.json`).then((d) => { entry.data = d; return d; })
        .catch((e) => { entry.error = e.message || String(e); return entry.data; })
        .finally(() => { entry.loading = null; });
      st.gaugeFiles.set(id, entry);
      return entry.loading;
    }

    // Último valor no nulo de una serie y su posición.
    const lastOf = (a) => { if (a) for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null) return [a[i], i]; return [null, -1]; };
    const hourAt = (G, i) => new Date(Date.parse(G.hourly.t0) + i * 3600000);
    const dayAt = (G, i) => new Date(Date.parse(G.daily.d0 + 'T12:00:00Z') + i * 86400000);
    const shortDate = (d, withYear) => d.toLocaleDateString(locale(), withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });

    // Gráfica genérica: barras, líneas, puntos y bandas sobre uno o dos ejes. Devuelve la
    // función que da la posición (0…n-1) bajo un punto x del lienzo, para el cursor.
    // Por serie: width, dash, alpha; part[] (puntos con datos a medias: barras claras,
    // puntos huecos); ref (número o lista: las barras por debajo salen en `under`);
    // w (ancho de la barra, 0-1). De la gráfica: ticks (rayas), xticks (rótulos), hi (resaltada).
    function chartXY(canvas, spec) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300, h = canvas.clientHeight || 110;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const color = (name, fb) => css.getPropertyValue(name).trim() || fb;
      const ink = color('--muted', '#576875'), line = color('--line', '#d6dee4'), bg = color('--side', '#f6f8fa');
      const pal = { accent: color('--accent', '#0077aa'), warm: color('--amber-ink', '#8a5a00'), ink };
      const axes = spec.axes.map((ax, k) => {
        const vals = [];
        for (const sr of spec.series) if ((sr.axis || 0) === k) for (const a of [sr.v, sr.lo, sr.hi]) if (a) for (const v of a) if (v !== null && v !== undefined) vals.push(v);
        let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
        if (ax.zero) lo = Math.min(0, lo);
        if (ax.fixed) [lo, hi] = ax.fixed;
        if (hi - lo < (ax.minSpan || 1)) { const m = (hi + lo) / 2; lo = ax.zero ? lo : m - (ax.minSpan || 1) / 2; hi = lo + (ax.minSpan || 1); }
        // nice: los tres valores de la rejilla redondos (0, 100, 200 en vez de 0, 92, 183).
        let dec;
        if (ax.nice) {
          const mag = 10 ** Math.floor(Math.log10((hi - lo) / 2));
          for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20]) {
            const half = k * mag, l0 = ax.zero ? lo : Math.floor(lo / half) * half;
            if (l0 + 2 * half >= hi - 1e-9) { lo = l0; hi = l0 + 2 * half; dec = half % 1 ? 1 : 0; break; }
          }
        }
        return { ...ax, lo, hi, dec };
      });
      const pad = { l: 34, r: axes[1] ? 34 : 6, t: 6, b: 16 };
      const n = spec.n;
      const bw = (w - pad.l - pad.r) / n;
      const x = (i) => pad.l + (i + 0.5) * bw;
      const y = (ax, v) => pad.t + (1 - (v - ax.lo) / (ax.hi - ax.lo || 1)) * (h - pad.t - pad.b);
      ctx.font = '10px ' + (css.getPropertyValue('--font') || 'sans-serif');
      ctx.lineWidth = 1;
      // Rejilla y etiquetas de los ejes.
      const fmt = (ax, v) => `${num(v, ax.dec !== undefined ? ax.dec : Math.abs(ax.hi - ax.lo) < 0.5 ? 2 : Math.abs(ax.hi - ax.lo) < 5 ? 1 : 0)}`;
      for (const f of [0, 0.5, 1]) {
        const v0 = axes[0].lo + f * (axes[0].hi - axes[0].lo);
        ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(pad.l, y(axes[0], v0)); ctx.lineTo(w - pad.r, y(axes[0], v0)); ctx.stroke();
        ctx.fillStyle = ink; ctx.fillText(fmt(axes[0], v0), 0, y(axes[0], v0) + 3);
        if (axes[1]) { const v1 = axes[1].lo + f * (axes[1].hi - axes[1].lo); const txt = fmt(axes[1], v1); ctx.fillStyle = pal.warm; ctx.fillText(txt, w - ctx.measureText(txt).width, y(axes[0], v0) + 3); }
      }
      ctx.fillStyle = ink;
      ctx.fillText(axes[0].unit, 0, h - 3);
      if (axes[1]) { ctx.fillStyle = pal.warm; ctx.fillText(axes[1].unit, w - ctx.measureText(axes[1].unit).width, h - 3); }
      // Separadores (días, meses o años) y la posición bajo el cursor.
      ctx.strokeStyle = line; ctx.setLineDash([2, 3]);
      for (const i of spec.ticks || []) { ctx.beginPath(); ctx.moveTo(pad.l + i * bw, pad.t); ctx.lineTo(pad.l + i * bw, h - pad.b); ctx.stroke(); }
      ctx.setLineDash([]);
      if (spec.hi !== null && spec.hi !== undefined) {
        const bx = Math.min(w - pad.r - 3, pad.l + spec.hi * bw + bw / 2 - Math.max(bw, 3) / 2);
        ctx.fillStyle = ink; ctx.globalAlpha = 0.16; ctx.fillRect(bx, pad.t, Math.max(bw, 3), h - pad.t - pad.b); ctx.globalAlpha = 1;
      }
      for (const sr of spec.series) {
        const ax = axes[sr.axis || 0];
        const c = pal[sr.color] || sr.color || pal.accent;
        if (sr.kind === 'band') {
          ctx.fillStyle = c; ctx.globalAlpha = 0.22;
          let run = [];
          const flush = () => {
            if (run.length > 1) {
              ctx.beginPath();
              run.forEach((i, k) => (k ? ctx.lineTo(x(i), y(ax, sr.hi[i])) : ctx.moveTo(x(i), y(ax, sr.hi[i]))));
              for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(x(run[k]), y(ax, sr.lo[run[k]]));
              ctx.closePath(); ctx.fill();
            }
            run = [];
          };
          for (let i = 0; i < n; i++) { if (sr.lo[i] === null || sr.hi[i] === null || sr.lo[i] === undefined || sr.hi[i] === undefined) flush(); else run.push(i); }
          flush();
          ctx.globalAlpha = 1;
        } else if (sr.kind === 'bar') {
          const bwid = Math.max(1, Math.min(bw * (sr.w || 0.8), 26));
          for (let i = 0; i < n; i++) {
            const v = sr.v[i];
            if (v === null || v === undefined || v <= 0) continue;
            const top = y(ax, v), base = y(ax, Math.max(ax.lo, 0)), ref = Array.isArray(sr.ref) ? sr.ref[i] : sr.ref;
            ctx.fillStyle = ref !== null && ref !== undefined && v < ref ? pal[sr.under || 'warm'] : c;
            ctx.globalAlpha = sr.part && sr.part[i] ? 0.35 : sr.alpha || 1;
            ctx.fillRect(x(i) - bwid / 2, top, bwid, Math.max(1, base - top));
          }
          ctx.globalAlpha = 1;
        } else if (sr.kind === 'dots') {
          ctx.fillStyle = c;
          for (let i = 0; i < n; i++) { const v = sr.v[i]; if (v === null || v === undefined) continue; ctx.beginPath(); ctx.arc(x(i), y(ax, v), sr.r || 2.5, 0, 7); ctx.fill(); }
        } else {
          ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = sr.width || 1.6; ctx.setLineDash(sr.dash || []); ctx.globalAlpha = sr.alpha || 1;
          const ok = (i) => sr.v[i] !== null && sr.v[i] !== undefined && !(sr.part && sr.part[i]);
          for (let i = 0; i < n; i++) {
            if (!ok(i)) continue;
            let j = i;
            while (j + 1 < n && ok(j + 1)) j++;
            ctx.beginPath();
            if (j === i) { ctx.setLineDash([]); ctx.arc(x(i), y(ax, sr.v[i]), 1.6, 0, 7); ctx.fill(); ctx.setLineDash(sr.dash || []); } else { for (let k = i; k <= j; k++) (k === i ? ctx.moveTo(x(k), y(ax, sr.v[k])) : ctx.lineTo(x(k), y(ax, sr.v[k]))); ctx.stroke(); }
            i = j;
          }
          // Los puntos con datos a medias, huecos y sin unir.
          if (sr.part) {
            ctx.setLineDash([]); ctx.lineWidth = 1.2; ctx.fillStyle = bg;
            for (let i = 0; i < n; i++) if (sr.part[i] && sr.v[i] !== null && sr.v[i] !== undefined) { ctx.beginPath(); ctx.arc(x(i), y(ax, sr.v[i]), 2.2, 0, 7); ctx.fill(); ctx.stroke(); }
          }
          ctx.setLineDash([]); ctx.lineWidth = 1; ctx.globalAlpha = 1;
        }
      }
      ctx.fillStyle = ink;
      if (spec.labels) {
        const [a, b] = spec.labels;
        ctx.fillText(a, pad.l, h - 3);
        ctx.fillText(b, w - pad.r - ctx.measureText(b).width, h - 3);
      }
      for (const [i, text] of spec.xticks || []) {
        const tw = ctx.measureText(text).width;
        ctx.fillText(text, Math.min(w - pad.r - tw, Math.max(pad.l, x(i) - tw / 2)), h - 3);
      }
      return (px) => { const i = Math.floor((px - pad.l) / bw); return i >= 0 && i < n ? i : null; };
    }

    const conv = (a, f) => (a ? a.map((v) => (v === null || v === undefined ? null : f(v))) : null);

    // Series de una variable del grupo en horas ('h') o días ('d').
    function groupSpec(G, group, kind) {
      const H = kind === 'h' ? G.hourly && G.hourly.vars : G.daily && G.daily.vars;
      if (!H) return null;
      const n = kind === 'h' ? (Object.values(H)[0] || []).length : (Object.values(H)[0] || []).length;
      if (!n) return null;
      const T = (k) => conv(H[k], tempVal), S = (k) => conv(H[k], speedVal), R = (k) => conv(H[k], rainVal), raw = (k) => H[k] || null;
      const has = (...ks) => ks.some((k) => H[k] && H[k].some((v) => v !== null));
      const zero = { zero: true };
      if (group === 'rain' && has('prec')) {
        const series = [{ kind: 'bar', v: R('prec'), color: 'accent' }];
        const axes = [{ unit: rainUnit(), ...zero, minSpan: inches() ? 0.1 : 2 }];
        if (kind === 'h' && has('ta')) { series.push({ kind: 'line', v: T('ta'), axis: 1, color: 'warm', width: 1.2 }); axes.push({ unit: tUnit(), minSpan: 4 }); }
        if (kind === 'd' && has('tmax')) { series.push({ kind: 'line', v: T('tmax'), axis: 1, color: 'warm', width: 1.2 }); axes.push({ unit: tUnit(), minSpan: 4 }); }
        return { n, series, axes, legend: kind === 'h' ? 'agua.lg.rainH' : 'agua.lg.rainD' };
      }
      if (group === 'temp' && has('ta', 'tmax')) {
        if (kind === 'h') return { n, axes: [{ unit: tUnit(), minSpan: 4 }], legend: 'agua.lg.tempH', series: [{ kind: 'band', lo: T('tamin') || [], hi: T('tamax') || [], color: 'warm' }, { kind: 'line', v: T('ta'), color: 'warm' }] };
        return { n, axes: [{ unit: tUnit(), minSpan: 4 }], legend: 'agua.lg.tempD', series: [{ kind: 'band', lo: T('tmin') || [], hi: T('tmax') || [], color: 'warm' }, { kind: 'line', v: T('tmed'), color: 'warm' }] };
      }
      if (group === 'hum' && has('hr', 'hrMedia')) {
        if (kind === 'h') return { n, axes: [{ unit: '%', fixed: [0, 100] }], legend: 'agua.lg.humH', series: [{ kind: 'line', v: raw('hr') }] };
        return { n, axes: [{ unit: '%', fixed: [0, 100] }], legend: 'agua.lg.humD', series: [{ kind: 'band', lo: raw('hrMin') || [], hi: raw('hrMax') || [] }, { kind: 'line', v: raw('hrMedia') }] };
      }
      if (group === 'wind' && has('vv', 'velmedia', 'racha')) {
        const a = kind === 'h' ? ['vv', 'vmax'] : ['velmedia', 'racha'];
        return { n, axes: [{ unit: sUnit(), ...zero, minSpan: 10 }], legend: 'agua.lg.wind', series: [{ kind: 'line', v: S(a[0]) }, { kind: 'line', v: S(a[1]), dash: [3, 3], width: 1.1, color: 'ink' }] };
      }
      if (group === 'pres' && has('pres_nmar', 'pres', 'presMax')) {
        if (kind === 'h') return { n, axes: [{ unit: 'hPa', minSpan: 6 }], legend: has('pres_nmar') ? 'agua.lg.presSea' : 'agua.lg.presStation', series: [{ kind: 'line', v: raw(has('pres_nmar') ? 'pres_nmar' : 'pres') }] };
        return { n, axes: [{ unit: 'hPa', minSpan: 6 }], legend: 'agua.lg.presD', series: [{ kind: 'band', lo: raw('presMin') || [], hi: raw('presMax') || [] }] };
      }
      if (group === 'sun' && has('inso', 'sol')) return { n, axes: [{ unit: kind === 'h' ? 'min' : 'h', ...zero, minSpan: kind === 'h' ? 60 : 4 }], legend: kind === 'h' ? 'agua.lg.sunH' : 'agua.lg.sunD', series: [{ kind: 'bar', v: raw(kind === 'h' ? 'inso' : 'sol'), color: 'warm' }] };
      if (group === 'soil' && kind === 'h' && has('ts', 'tss5cm', 'tss20cm')) return { n, axes: [{ unit: tUnit(), minSpan: 4 }], legend: 'agua.lg.soil', series: [{ kind: 'line', v: T('ts'), color: 'warm' }, { kind: 'line', v: T('tss5cm'), dash: [4, 2] }, { kind: 'line', v: T('tss20cm'), dash: [1, 2], color: 'ink' }] };
      if (group === 'snow' && kind === 'h' && has('nieve')) return { n, axes: [{ unit: 'cm', ...zero, minSpan: 5 }], legend: 'agua.lg.snow', series: [{ kind: 'line', v: raw('nieve') }] };
      if (group === 'vis' && kind === 'h' && has('vis')) return { n, axes: [{ unit: 'km', ...zero, minSpan: 5 }], legend: 'agua.lg.vis', series: [{ kind: 'line', v: raw('vis') }] };
      return null;
    }

    // Recorta una serie a los últimos `keep` puntos.
    function tail(spec, keep) {
      if (!spec || spec.n <= keep) return spec;
      const off = spec.n - keep;
      const cut = (a) => (a ? a.slice(off) : a);
      return { ...spec, n: keep, off, series: spec.series.map((sr) => ({ ...sr, v: cut(sr.v), lo: cut(sr.lo), hi: cut(sr.hi) })) };
    }

    // Lluvia de cada mes (con todos los días guardados).
    function monthly(G) {
      const p = G.daily && G.daily.vars.prec;
      if (!p) return null;
      const sums = new Map();
      p.forEach((v, i) => {
        const k = dayAt(G, i).toISOString().slice(0, 7);
        const e = sums.get(k) || { mm: 0, n: 0, days: 0 };
        e.days++;
        if (v !== null) { e.mm += v; e.n++; }
        sums.set(k, e);
      });
      const keys = [...sums.keys()];
      if (keys.length < 2) return null;
      // Meses con menos del 90 % de los días: sin barra (el primero y el último suelen estar a medias).
      return { keys, v: keys.map((k) => { const e = sums.get(k); const dim = new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate(); return e.n >= dim * 0.9 ? e.mm : null; }), partial: keys.map((k) => sums.get(k).n) };
    }

    function records(G) {
      const D = G.daily && G.daily.vars;
      if (!D) return [];
      const best = (k, cmp) => { const a = D[k]; if (!a) return null; let bi = -1; a.forEach((v, i) => { if (v !== null && (bi < 0 || cmp(v, a[bi]))) bi = i; }); return bi < 0 ? null : [a[bi], dayAt(G, bi)]; };
      const out = [];
      const add = (label, r, fmt) => { if (r) out.push(`<div><dt>${esc(t(label))}</dt><dd>${esc(fmt(r[0]))} <small>${esc(shortDate(r[1], true))}</small></dd></div>`); };
      add('agua.rec.rain', best('prec', (a, b) => a > b), (v) => rain(v));
      add('agua.rec.tmax', best('tmax', (a, b) => a > b), tempTxt);
      add('agua.rec.tmin', best('tmin', (a, b) => a < b), tempTxt);
      add('agua.rec.gust', best('racha', (a, b) => a > b), speedTxt);
      return out;
    }

    // ---- Historia larga (history, normals y records de la ficha; ver shared/clima.js) ----

    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const monthName = (m, style = 'long') => new Date(Date.UTC(2001, m % 12, 15, 12)).toLocaleDateString(locale(), { month: style, timeZone: 'UTC' });
    const monthShort = (m) => monthName(m, 'short').replace(/\.$/, '').slice(0, 3);
    const pctInt = (p) => (p === null || p === undefined ? '—' : `${num(p, 0)}\u00a0%`);
    const daysTxt = (n) => t(n === 1 ? 'agua.nDay' : 'agua.nDays', { n: num(n, Number.isInteger(n) ? 0 : 1) });
    const tShort = (c) => `${num(tempVal(c), 0)}\u00a0${tUnit()}`;
    // 'YYYY-MM-DD' → «12 oct 1982»; 'YYYY-MM' → «oct 1982».
    const recDate = (d) => (typeof d !== 'string' ? '' : d.length >= 10 ? shortDate(new Date(d.slice(0, 10) + 'T12:00:00Z'), true) : d.length === 7 ? monthYear(d) : '');
    const mLabel = (i) => monthYear(CL.mKey(i));
    // El último día con datos de lluvia (AEMET publica con unos días de retraso).
    const dataUntil = (G) => {
      const [, i] = lastOf(G.daily && G.daily.vars && G.daily.vars.prec);
      return i >= 0 ? dayAt(G, i).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    };

    // Cómo se ve cada variable con historia: clave, cómo resumir el año, unidades y formato.
    const HV = (id) => ({
      rain: { k: 'prec', how: 'sum', cv: rainVal, fmt: rain, ax: { unit: rainUnit(), zero: true, nice: true, minSpan: rainVal(50) } },
      temp: { k: 'tmean', how: 'mean', cv: tempVal, fmt: tempTxt, ax: { unit: tUnit(), nice: true, minSpan: 4 } },
      hum: { k: 'hr', how: 'mean', cv: (v) => v, fmt: (v) => `${num(v, 0)}\u00a0%`, ax: { unit: '%', nice: true, minSpan: 10 } },
      wind: { k: 'wind', how: 'mean', cv: speedVal, fmt: speedTxt, ax: { unit: sUnit(), zero: true, nice: true, minSpan: 10 } },
      sun: { k: 'sun', how: 'mean', cv: (v) => v, fmt: (v) => `${num(v, 1)} h`, ax: { unit: 'h', zero: true, nice: true, minSpan: 4 } }
    }[id] || null);
    const nrmLine = (n, v) => (v === null || v === undefined ? [] : [{ kind: 'line', v: Array(n).fill(v), color: 'ink', dash: [4, 3], width: 1.2 }]);

    // Una variable año a año, con lo normal como referencia: { spec, text(i), dflt, legend }.
    function yearView(G, id) {
      const d = HV(id), H = G.history;
      if (!d || !hasHist(G, id)) return null;
      const P = CL.yearly(H, d.k, d.how);
      if (!P || P.v.length < 2) return null;
      const N = G.normals && G.normals.year, nv = N && N[d.k] !== undefined ? N[d.k] : null;
      const n = P.v.length, part = P.cov.map((c) => c < CL.COMPLETE);
      const half = (Y) => Y.v.map((x, i) => (Y.cov[i] >= 0.5 ? x : null)); // la banda, con medio año al menos
      const series = [];
      if (id === 'temp') {
        const hi = CL.yearly(H, 'tmax', 'mean'), lo = CL.yearly(H, 'tmin', 'mean');
        if (hi && lo) series.push({ kind: 'band', lo: conv(half(lo), tempVal), hi: conv(half(hi), tempVal), color: 'warm' });
      }
      series.push(...nrmLine(n, nv === null ? null : d.cv(nv)));
      if (id === 'rain' || id === 'sun') series.push({ kind: 'bar', v: conv(P.v, d.cv), part, color: id === 'sun' ? 'warm' : 'accent', ref: id === 'rain' && nv !== null ? d.cv(nv) : null });
      else series.push({ kind: 'line', v: conv(P.v, d.cv), part, color: id === 'temp' ? 'warm' : 'accent' });
      let G2 = null;
      if (id === 'wind') {
        G2 = CL.yearly(H, 'gust', 'max');
        if (G2) series.push({ kind: 'line', axis: 1, v: conv(G2.v, speedVal), part: G2.cov.map((c) => c < CL.COMPLETE), color: 'warm', width: 1.1, dash: [2, 2] });
      }
      // Rótulos del eje: lo bastante espaciados para 100 años o para 3.
      const step = [1, 2, 5, 10, 20, 50].find((s) => n / s <= 8), xticks = [];
      for (let y = P.y0; y < P.y0 + n; y++) if (y % step === 0) xticks.push([y - P.y0, String(y)]);
      const text = (i) => {
        const v = P.v[i];
        if (v === null) return `${P.y0 + i}: —`;
        const g = G2 && G2.v[i] !== null && G2.v[i] !== undefined ? `, ${t('agua.v.gust').toLowerCase()} ${speedTxt(G2.v[i])}` : '';
        return [`${P.y0 + i}: ${d.fmt(v)}${g}`, nv !== null ? `${t('agua.hover.normal')}: ${d.fmt(nv)}` : '', part[i] ? t('agua.hover.partial', { pct: pctInt(100 * P.cov[i]) }) : ''].filter(Boolean).join(' · ');
      };
      const X = CL.extremes(P);
      const per = (G.normals && G.normals.period) || '';
      const legend = [t('agua.lg.y.' + id), id === 'rain' && nv !== null ? t('agua.lg.rainCls') : '', nv !== null ? t('agua.lg.normal', { period: per }) : '', part.some(Boolean) ? t('agua.lg.partial') : ''].filter(Boolean).join(' ');
      return { n, y0: P.y0, spec: { n, axes: [d.ax, ...(G2 ? [{ ...d.ax }] : [])], series, xticks, ticks: xticks.map(([i]) => i) }, text, legend, dflt: X ? t('agua.ext.' + id, { hi: `${X.hi[0]} (${d.fmt(X.hi[1])})`, lo: `${X.lo[0]} (${d.fmt(X.lo[1])})` }) : t('agua.hoverHint') };
    }

    // Los últimos `years` años mes a mes, con lo normal de cada mes.
    function monthView(G, id, years = 5) {
      const d = HV(id), H = G.history, g = GROUPS.find((x) => x.id === id);
      if (!d || !hasHist(G, id)) return null;
      const len = CL.length(H, g.m);
      if (len < 2) return null;
      const f0 = CL.mIdx(H.m0), n = Math.min(years * 12, len), start = f0 + len - n;
      const sl = (k) => Array.from({ length: n }, (_, i) => CL.at(H, k, start + i));
      const Nm = G.normals && G.normals.months, nm = Nm && Nm[d.k] ? Array.from({ length: n }, (_, i) => { const v = Nm[d.k][(start + i) % 12]; return v === undefined ? null : v; }) : null;
      const P = sl(d.k), cov = sl('cov'), nmv = nm ? conv(nm, d.cv) : null;
      const part = id === 'rain' ? cov.map((c) => c !== null && c < 100 * CL.COMPLETE) : null;
      const series = [];
      if (id === 'temp') series.push({ kind: 'band', lo: conv(sl('tmin'), tempVal), hi: conv(sl('tmax'), tempVal), color: 'warm' });
      if (nmv) series.push({ kind: 'line', v: nmv, color: 'ink', dash: [4, 3], width: 1.2 });
      if (id === 'rain' || id === 'sun') series.push({ kind: 'bar', v: conv(P, d.cv), part, color: id === 'sun' ? 'warm' : 'accent', ref: id === 'rain' ? nmv : null });
      else series.push({ kind: 'line', v: conv(P, d.cv), color: id === 'temp' ? 'warm' : 'accent' });
      const gu = id === 'wind' ? sl('gust') : null;
      if (gu) series.push({ kind: 'line', axis: 1, v: conv(gu, speedVal), color: 'warm', width: 1.1, dash: [2, 2] });
      const xticks = [];
      for (let i = 0; i < n; i++) if ((start + i) % 12 === 0) xticks.push([i, String(Math.floor((start + i) / 12))]);
      const text = (i) => {
        const v = P[i];
        const gs = gu && gu[i] !== null ? `, ${t('agua.v.gust').toLowerCase()} ${speedTxt(gu[i])}` : '';
        return [`${mLabel(start + i)}: ${v === null ? '—' : d.fmt(v)}${v === null ? '' : gs}`, nm && nm[i] !== null ? `${t('agua.hover.normal')}: ${d.fmt(nm[i])}` : '', part && part[i] ? t('agua.hover.partialM', { pct: pctInt(cov[i]) }) : ''].filter(Boolean).join(' · ');
      };
      return { n, spec: { n, axes: [{ ...d.ax, minSpan: id === 'rain' ? rainVal(20) : d.ax.minSpan }, ...(gu ? [{ ...d.ax }] : [])], series, xticks, ticks: xticks.map(([i]) => i), labels: xticks.length ? null : [mLabel(start), mLabel(start + n - 1)] }, text, legend: [t('agua.lg.m.' + id), id === 'rain' && nmv ? t('agua.lg.rainCls') : '', nmv ? t('agua.lg.normalM', { period: (G.normals && G.normals.period) || '' }) : ''].filter(Boolean).join(' '), dflt: t('agua.hoverHint') };
    }

    // Climograma: lo normal de cada mes (lluvia, máxima y mínima) y los últimos 12 meses enteros encima.
    function climoView(G) {
      const Nm = G.normals && G.normals.months, Ny = (G.normals && G.normals.year) || {}, H = G.history;
      const has = (k) => !!(Nm && Nm[k] && Nm[k].some((v) => v !== null && v !== undefined));
      if (!has('prec')) return null;
      const temps = has('tmax') && has('tmin');
      const end = CL.lastComplete(dataUntil(G));
      // Para cada mes del año, su última aparición entre los 12 meses últimos (o ninguna).
      const win = Array.from({ length: 12 }, () => null);
      if (H) for (let i = end - 11; i <= end; i++) win[i % 12] = i;
      const real = (k, i) => (i === null ? null : k === 'prec' ? (CL.cover(H, 'prec', i) >= CL.MONTH_OK ? CL.at(H, 'prec', i) : null) : CL.at(H, k, i));
      const act = (k) => win.map((i) => real(k, i));
      const hasAct = H && act('prec').some((v) => v !== null);
      const pN = conv(Nm.prec, rainVal);
      const series = [];
      if (temps) series.push({ kind: 'band', axis: 1, lo: conv(Nm.tmin, tempVal), hi: conv(Nm.tmax, tempVal), color: 'warm' });
      series.push({ kind: 'bar', v: pN, alpha: 0.3, w: 0.9 });
      if (hasAct) series.push({ kind: 'bar', v: conv(act('prec'), rainVal), w: 0.42, ref: pN, under: 'warm' });
      if (temps) {
        series.push({ kind: 'line', axis: 1, v: conv(Nm.tmax, tempVal), color: 'warm', width: 1.4 }, { kind: 'line', axis: 1, v: conv(Nm.tmin, tempVal), color: 'warm', width: 1.4 });
        if (hasAct) series.push({ kind: 'dots', axis: 1, v: conv(act('tmax'), tempVal), color: 'warm', r: 2.6 }, { kind: 'dots', axis: 1, v: conv(act('tmin'), tempVal), color: 'warm', r: 2.6 });
      }
      const range = (lo, hi) => (lo === null || hi === null || lo === undefined || hi === undefined ? '' : `, ${num(tempVal(lo), 0)} ${t('agua.hover.to')} ${num(tempVal(hi), 0)}\u00a0${tUnit()}`);
      const text = (m) => {
        const i = win[m], r = real('prec', i);
        const parts = [`${t('agua.hover.normal')}: ${rain(Nm.prec[m])}${temps ? range(Nm.tmin[m], Nm.tmax[m]) : ''}`];
        if (i !== null && (r !== null || real('tmax', i) !== null)) parts.push(`${mLabel(i)}: ${r === null ? '—' : rain(r)}${temps ? range(real('tmin', i), real('tmax', i)) : ''}`);
        return `${cap(monthName(m))} — ${parts.join(' · ')}`;
      };
      const year = Ny.prec !== null && Ny.prec !== undefined && Ny.tmean !== null && Ny.tmean !== undefined ? t('agua.climo.year', { rain: rain(Ny.prec), temp: tempTxt(Ny.tmean) }) : t('agua.hoverHint');
      const per = G.normals.period || '';
      return { spec: { n: 12, axes: [{ unit: rainUnit(), zero: true, nice: true, minSpan: rainVal(40) }, ...(temps ? [{ unit: tUnit(), nice: true, minSpan: 10 }] : [])], series, xticks: Array.from({ length: 12 }, (_, m) => [m, monthShort(m)]) }, text, dflt: year,
        legend: hasAct ? t('agua.lg.climo', { period: per, from: mLabel(end - 11), to: mLabel(end) }) : t('agua.lg.climoN', { period: per }) };
    }

    // «Comparado con lo normal»: este mes, el año hidrológico y el último mes entero.
    function vsHtml(G) {
      if (!G.history || !G.normals) return '';
      const c = CL.compare(G.history, G.normals, dataUntil(G));
      const row = (k, v) => `<div><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
      const of = (key, o) => t(key, { pct: pctInt(o.pct), normal: rain(o.normal) });
      const rows = [];
      if (c.month && c.month.pct !== null) rows.push(row(cap(t('agua.vs.monthSoFar', { month: monthName(CL.mIdx(c.month.key)), day: c.month.day })), `${esc(rain(c.month.mm))}, ${esc(of('agua.vs.ofMonth', c.month))}`));
      if (c.hydro && c.hydro.pct !== null) rows.push(row(t('agua.vs.hydro'), `${esc(rain(c.hydro.mm))}, ${esc(of('agua.vs.ofDate', c.hydro))}${c.hydro.cov < 0.9 ? ` <small>${esc(t('agua.vs.partial'))}</small>` : ''}`));
      const L = c.last;
      if (L && L.rain) {
        const cls = L.rain.cls === null ? '' : ` <strong class="cls c${L.rain.cls}">${esc(t('agua.vs.c' + L.rain.cls))}</strong>,`;
        rows.push(row(cap(t('agua.vs.rainOf', { month: monthName(CL.mIdx(L.key)) })), `${esc(rain(L.rain.mm))},${cls} ${esc(L.rain.pct === null ? '' : of('agua.vs.ofMonth', L.rain))}`));
      }
      if (L && L.temp) {
        const dd = imperial() ? L.temp.delta * 1.8 : L.temp.delta, dTxt = `${num(Math.abs(dd), 1)}\u00a0${tUnit()}`;
        const how = Math.abs(dd) < 0.05 ? t('agua.vs.same') : dd > 0 ? t('agua.vs.above', { d: `+${dTxt}` }) : t('agua.vs.below', { d: dTxt });
        rows.push(row(cap(t('agua.vs.tempOf', { month: monthName(CL.mIdx(L.key)) })), `${esc(tempTxt(L.temp.t))}, ${esc(how)} <small>(${esc(tempTxt(L.temp.normal))})</small>`));
      }
      if (!rows.length) return '';
      return `<h3>${esc(t('agua.vs.title'))}</h3><div class="agua-vs">${rows.join('')}</div><p class="hint">${esc(t('agua.vs.period', { period: G.normals.period || '' }))}</p>`;
    }

    // Una sección que se pliega; recuerda si está abierta aunque la ficha se repinte.
    const secOpen = (key, dflt) => (st.gOpen.has(key) ? st.gOpen.get(key) : dflt);
    const sec = (key, title, body, dflt = true) => `<details class="agua-sec" data-sec="${key}"${secOpen(key, dflt) ? ' open' : ''}><summary><h3>${esc(title)}</h3></summary>${body}</details>`;

    // Récords: los oficiales de AEMET o los calculados con el histórico.
    function recordsHtml(G) {
      const R = G.records, all = R && R.all;
      if (!all) return '';
      const F = { precDay: rain, precHi: rain, precLo: rain, rainDays: daysTxt, tmaxHi: tempTxt, tminLo: tempTxt, tmeanHi: tempTxt, tmeanLo: tempTxt, gustHi: speedTxt, snowDays: daysTxt, stormDays: daysTxt };
      const rows = Object.keys(F).filter((k) => Array.isArray(all[k]) && all[k][0] !== null && all[k][0] !== undefined);
      if (!rows.length) return '';
      const calc = R.source === 'calculado';
      let body = `<p class="hint">${esc(calc ? t('agua.recNoteCalc', { from: R.from ? monthYear(R.from) : '' }) : t('agua.recNoteAemet'))}</p>`;
      body += `<dl class="agua-dam">${rows.map((k) => `<div><dt>${esc(t('agua.rec.' + k))}</dt><dd>${esc(F[k](all[k][0]))} <small>${esc(recDate(all[k][1]))}</small></dd></div>`).join('')}</dl>`;
      // Récord de cada mes, en una tabla.
      const cols = ['precDay', 'tmaxHi', 'tminLo', 'gustHi'].filter((k) => R.month && Array.isArray(R.month[k]) && R.month[k].some((e) => e));
      if (cols.length) {
        const cell = (k, m) => { const e = R.month[k][m]; return e ? `${esc(F[k](e[0]))} <small>${esc(String(e[1]).slice(0, 4))}</small>` : '—'; };
        body += `<details class="agua-sub" data-sec="recmonths"${secOpen('recmonths', false) ? ' open' : ''}><summary>${esc(t('agua.rec.monthly'))}</summary><div class="agua-scroll"><table class="agua-tbl"><thead><tr><th>${esc(t('agua.rec.m.month'))}</th>${cols.map((k) => `<th>${esc(t('agua.rec.m.' + k))}</th>`).join('')}</tr></thead><tbody>${
          Array.from({ length: 12 }, (_, m) => `<tr><td>${esc(cap(monthShort(m)))}</td>${cols.map((k) => `<td>${cell(k, m)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
      }
      return sec('recs', t(calc ? 'agua.recCalc' : 'agua.recAemet'), body);
    }

    // Normales de AEMET, mes a mes.
    function normalsHtml(G) {
      const N = G.normals;
      if (!N || !N.months) return '';
      const M = N.months, Y = N.year || {};
      const has = (k) => (M[k] && M[k].some((v) => v !== null && v !== undefined)) || (Y[k] !== null && Y[k] !== undefined);
      // Una tabla con una fila por mes y la del año; cada columna: [clave, formato, unidad, grupo].
      const table = (cols) => {
        cols = cols.filter(([k]) => has(k));
        if (!cols.length) return '';
        const f = (fn, v) => (v === null || v === undefined ? '—' : esc(fn(v)));
        const head = cols.map(([k, , u]) => `<th>${esc(t('agua.norm.' + k))}${u ? `<small>${esc(u)}</small>` : ''}</th>`).join('');
        // Fila de grupos (Lluvia, Temperatura) sobre las columnas que comparten uno.
        let groups = '';
        for (let i = 0; i < cols.length;) {
          let j = i + 1;
          while (cols[i][3] && j < cols.length && cols[j][3] === cols[i][3]) j++;
          groups += `<th${j - i > 1 ? ` colspan="${j - i}"` : ''}>${cols[i][3] ? esc(t('agua.g.' + cols[i][3])) : ''}</th>`;
          i = j;
        }
        const months = Array.from({ length: 12 }, (_, m) => `<tr><td>${esc(cap(monthShort(m)))}</td>${cols.map(([k, fn]) => `<td>${f(fn, M[k] ? M[k][m] : null)}</td>`).join('')}</tr>`).join('');
        return `<div class="agua-scroll"><table class="agua-tbl"><thead>${cols.some((c) => c[3]) ? `<tr class="grp"><th></th>${groups}</tr>` : ''}<tr><th></th>${head}</tr></thead><tbody>${months}<tr class="tot"><td>${esc(t('agua.norm.year'))}</td>${cols.map(([k, fn]) => `<td>${f(fn, Y[k])}</td>`).join('')}</tr></tbody></table></div>`;
      };
      const d1 = (v) => num(v, 1), tv = (v) => num(tempVal(v), 1);
      const main = table([['prec', (v) => num(rainVal(v), inches() ? 2 : 1), rainUnit(), 'rain'], ['rainDays', d1, '', 'rain'], ['tmean', tv, tUnit(), 'temp'], ['tmax', tv, tUnit(), 'temp'], ['tmin', tv, tUnit(), 'temp'], ['hr', (v) => num(v, 0), '%'], ['wind', (v) => num(speedVal(v), 0), sUnit()], ['sun', d1, 'h']]);
      const days = table(['frostDays', 'hotDays', 'snowDays', 'stormDays', 'fogDays', 'clearDays'].map((k) => [k, d1, '']));
      if (!main && !days) return '';
      const body = `<p class="hint">${esc(t('agua.normNote', { period: N.period || '', n: N.n || '' }))}</p>${main}${days ? `<p class="agua-subtitle">${esc(t('agua.norm.daysTitle'))}</p>${days}` : ''}${has('frostDays') || has('hotDays') ? `<p class="hint">${esc(t('agua.norm.daysNote', { frost: tShort(0), hot: tShort(30) }))}</p>` : ''}`;
      return sec('norm', t('agua.norm', { period: N.period || '' }), body, false);
    }

    function renderGauge() {
      const id = st.gauge;
      const row = gaugeRows().find((g) => g[0] === id);
      const e = st.gaugeFiles.get(id);
      const G = e && e.data;
      let html = `<div class="agua-res-head"><button type="button" class="icon-btn" data-gauge-back aria-label="${esc(t('agua.gaugeBack'))}" title="${esc(t('agua.gaugeBack'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button><span>${esc(t('agua.gauges'))}</span></div>`;
      html += `<h2 class="agua-res-name">${esc((G && G.name) || (row && row[1]) || id)}</h2>`;
      if (G) html += `<p class="hint">${esc([G.prov, Number.isFinite(G.alt) ? `${num(G.alt)} m` : '', `AEMET ${id}`].filter(Boolean).join(' · '))}</p>`;
      // Lluvia acumulada.
      if (row) {
        const cells = [['agua.gaugesLastHour', row[4]], ['agua.p.h24', row[5]], ['agua.p.d7', row[6]], ['agua.p.d30', row[7]], ['agua.p.year', row[8]]];
        html += `<dl class="agua-rain five">${cells.map(([k, v]) => `<div><dt>${esc(t(k))}</dt><dd>${esc(rain(v))}</dd></div>`).join('')}</dl>`;
        const p = st.pluvio;
        if (p && p.periodsUntil && Date.parse(p.until) - Date.parse(p.periodsUntil) > 3 * 3600000) html += `<p class="hint">${esc(t('agua.gaugeLag', { date: dateText(new Date(Date.parse(p.periodsUntil) - 8 * 3600000).toISOString().slice(0, 10)) }))}</p>`;
      }
      if (!G) return html + `<p class="hint">${esc(e && e.loading ? t('agua.loading') : t('agua.gaugeError'))}</p>`;
      html += vsHtml(G);
      // Última observación: todo lo que mide la estación.
      const Hv = (G.hourly && G.hourly.vars) || {};
      const [, iLast] = lastOf(Hv.ta || Hv.prec || Hv.hr || Object.values(Hv)[0]);
      if (iLast >= 0) {
        const v = (k) => (Hv[k] ? Hv[k][iLast] : null);
        const day = Hv.ta ? Hv.ta.slice(Math.max(0, iLast - 23), iLast + 1).filter((x) => x !== null) : [];
        const facts = [
          ['agua.v.temp', v('ta') !== null ? `${tempTxt(v('ta'))}${day.length > 12 ? ` <small>(${esc(tempTxt(Math.min(...day)))} / ${esc(tempTxt(Math.max(...day)))} ${esc(t('agua.v.in24'))})</small>` : ''}` : null],
          ['agua.v.hum', v('hr') !== null ? `${num(v('hr'))} %` : null],
          ['agua.v.dew', v('tpr') !== null ? tempTxt(v('tpr')) : null],
          ['agua.v.wind', v('vv') !== null ? `${speedTxt(v('vv'))} ${compass(v('dv'))}` : null],
          ['agua.v.gust', v('vmax') !== null ? `${speedTxt(v('vmax'))} ${compass(v('dmax'))}` : null],
          ['agua.v.pres', v('pres_nmar') !== null ? `${num(v('pres_nmar'), 1)} hPa` : v('pres') !== null ? `${num(v('pres'), 1)} hPa <small>${esc(t('agua.v.presStation'))}</small>` : null],
          ['agua.v.sun', v('inso') !== null ? `${num(v('inso'))} min` : null],
          ['agua.v.vis', v('vis') !== null ? `${num(v('vis'), 1)} km` : null],
          ['agua.v.soil', v('ts') !== null ? tempTxt(v('ts')) : null],
          ['agua.v.snow', v('nieve') !== null ? `${num(v('nieve'))} cm` : null]
        ].filter(([, x]) => x !== null);
        const when = hourAt(G, iLast).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        html += `<h3>${esc(t('agua.gaugeNow', { time: when }))}</h3><dl class="agua-dam">${facts.map(([k, x]) => `<div><dt>${esc(t(k))}</dt><dd>${x.includes('<small>') ? x : esc(x)}</dd></div>`).join('')}</dl>`;
      }
      // Gráficas de la variable elegida: horas, días, meses y años.
      const groups = GROUPS.filter((g) => groupSpec(G, g.id, 'h') || groupSpec(G, g.id, 'd') || hasHist(G, g.id));
      if (!groups.some((g) => g.id === st.gaugeVar)) st.gaugeVar = groups.length ? groups[0].id : 'rain';
      st.gv = { month: monthView(G, st.gaugeVar), year: yearView(G, st.gaugeVar), climo: climoView(G) };
      const chart = (kind, v) => `<canvas class="agua-chart tall" data-chart="${kind}"></canvas><p class="agua-readout${kind === 'g-climo' ? ' two' : ''}"></p><p class="hint">${esc(v.legend)}</p>`;
      if (groups.length) {
        html += `<div class="chips" role="group" aria-label="${esc(t('agua.variable'))}">${groups.map((g) => `<button type="button" data-gvar="${g.id}" aria-pressed="${st.gaugeVar === g.id}">${esc(t('agua.g.' + g.id))}</button>`).join('')}</div>`;
        const hs = groupSpec(G, st.gaugeVar, 'h');
        if (hs) html += `<h3>${esc(t('agua.hourlyChart', { n: Math.round(hs.n / 24) }))}</h3><canvas class="agua-chart tall" data-chart="g-hour"></canvas><p class="hint">${esc(t(hs.legend))}</p>`;
        const ds = tail(groupSpec(G, st.gaugeVar, 'd'), 92);
        if (ds) html += `<h3>${esc(t('agua.dailyChart', { n: ds.n }))}</h3><canvas class="agua-chart tall" data-chart="g-day"></canvas><p class="hint">${esc(t(ds.legend))}</p>`;
        const { month: mv, year: yv } = st.gv;
        if (mv) html += sec('hmonths', mv.n >= 24 ? t('agua.histMonths', { n: Math.round(mv.n / 12) }) : t('agua.histMonthsShort', { n: mv.n }), chart('g-hmonth', mv));
        if (yv) html += sec('hyears', t('agua.histYears', { y: yv.y0 }), chart('g-year', yv) + (G.history.complete === false ? `<p class="hint">${esc(t('agua.histFilling', { y: G.history.m0.slice(0, 4) }))}</p>` : ''));
      }
      // Sin historia larga, la lluvia de cada mes de los 2 años de datos diarios.
      const mo = G.history ? null : monthly(G);
      if (mo) html += `<h3>${esc(t('agua.monthlyChart'))}</h3><canvas class="agua-chart" data-chart="g-month"></canvas>`;
      if (st.gv.climo) html += sec('climo', t('agua.climo'), chart('g-climo', st.gv.climo));
      // Récords: oficiales de AEMET o calculados; si no hay, los de los 2 años de datos diarios.
      const recs = recordsHtml(G);
      const rec = recs ? [] : records(G);
      html += recs;
      if (rec.length) html += `<h3>${esc(t('agua.recordsSince', { date: shortDate(dayAt(G, 0), true) }))}</h3><dl class="agua-dam">${rec.join('')}</dl>`;
      if (!recs && G.history && G.history.complete === false) html += `<p class="hint">${esc(t('agua.recWait'))}</p>`;
      html += normalsHtml(G);
      html += `<p class="agua-csv"><button type="button" class="link-btn" data-csv="h">${esc(t('agua.csvHours'))}</button><button type="button" class="link-btn" data-csv="d">${esc(t('agua.csvDays'))}</button>${G.history ? `<button type="button" class="link-btn" data-csv="m">${esc(t('agua.csvMonths'))}</button>` : ''}</p>`;
      html += `<p class="hint">${esc(t('agua.gaugeSource'))}</p>`;
      return html;
    }

    function drawGaugeCharts(el) {
      const G = st.gauge && st.gaugeFiles.get(st.gauge) && st.gaugeFiles.get(st.gauge).data;
      if (!G) return;
      st.charts = new Map();
      el.querySelectorAll('canvas[data-chart^="g-"]').forEach((c) => {
        if (c.closest('details:not([open])')) return; // se dibuja al abrir la sección
        const kind = c.dataset.chart, V = st.gv || {};
        const view = kind === 'g-hmonth' ? V.month : kind === 'g-year' ? V.year : kind === 'g-climo' ? V.climo : null;
        if (view) {
          // Con lectura al pasar el cursor (o tocar): ver `hover`.
          st.charts.set(c, { ...view, hi: null, at: chartXY(c, view.spec) });
          const ro = c.nextElementSibling;
          if (ro && ro.classList.contains('agua-readout')) ro.textContent = view.dflt;
        } else if (kind === 'g-hour') {
          const sp = groupSpec(G, st.gaugeVar, 'h');
          const ticks = [];
          for (let i = 1; i < sp.n; i++) if (hourAt(G, i).getHours() === 0) ticks.push(i);
          chartXY(c, { ...sp, ticks, labels: [shortDate(hourAt(G, 0)), hourAt(G, sp.n - 1).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })] });
        } else if (kind === 'g-day') {
          const sp = tail(groupSpec(G, st.gaugeVar, 'd'), 92);
          const off = sp.off || 0, ticks = [];
          for (let i = 1; i < sp.n; i++) if (dayAt(G, off + i).getUTCDate() === 1) ticks.push(i);
          chartXY(c, { ...sp, ticks, labels: [shortDate(dayAt(G, off)), shortDate(dayAt(G, off + sp.n - 1))] });
        } else if (kind === 'g-month') {
          const mo = monthly(G);
          const label = (k) => new Date(k + '-15T12:00:00Z').toLocaleDateString(locale(), { month: 'short', year: 'numeric' });
          chartXY(c, { n: mo.keys.length, axes: [{ unit: rainUnit(), zero: true, minSpan: 10 }], series: [{ kind: 'bar', v: conv(mo.v, rainVal) }], labels: [label(mo.keys[0]), label(mo.keys[mo.keys.length - 1])] });
        }
      });
    }

    // Lectura de la gráfica bajo el cursor (o el dedo): resalta el mes o el año y dice su valor.
    function hover(e) {
      const c = e.target.closest && e.target.closest('canvas.agua-chart');
      const info = c && st.charts.get(c);
      if (!info) return;
      if (e.type === 'pointerleave' && e.pointerType !== 'mouse') return; // con el dedo, la lectura se queda hasta el siguiente toque
      const i = e.type === 'pointerleave' ? null : info.at(e.clientX - c.getBoundingClientRect().left);
      if (i === info.hi) return;
      info.hi = i;
      chartXY(c, { ...info.spec, hi: i });
      const ro = c.nextElementSibling;
      if (ro) ro.textContent = i === null ? info.dflt : info.text(i);
    }

    // Todo lo guardado de la estación, en CSV (unidades de AEMET).
    const UNITS = { prec: 'mm', ta: 'C', tamin: 'C', tamax: 'C', tpr: 'C', ts: 'C', tss5cm: 'C', tss20cm: 'C', tmed: 'C', tmin: 'C', tmax: 'C', hr: '%', hrMedia: '%', hrMax: '%', hrMin: '%', vv: 'm_s', vmax: 'm_s', velmedia: 'm_s', racha: 'm_s', dv: 'grados', dmax: 'grados', dir: 'grados', pres: 'hPa', pres_nmar: 'hPa', presMax: 'hPa', presMin: 'hPa', inso: 'min', sol: 'h', vis: 'km', nieve: 'cm', pintMax: 'mm_h',
      rainDays: 'dias', rainDays1: 'dias', precMax: 'mm', tmean: 'C', tmaxAbs: 'C', tminAbs: 'C', wind: 'm_s', gust: 'm_s', sun: 'h', cov: '%' };
    function downloadCsv(kind) {
      const G = st.gaugeFiles.get(st.gauge) && st.gaugeFiles.get(st.gauge).data;
      const block = G && (kind === 'h' ? G.hourly : kind === 'd' ? G.daily : G.history && { vars: Object.fromEntries(Object.entries(G.history).filter(([, a]) => Array.isArray(a))) });
      if (!block) return;
      const keys = Object.keys(block.vars);
      const n = Math.max(...keys.map((k) => block.vars[k].length));
      const lines = [[kind === 'h' ? 'fecha_hora_utc' : kind === 'd' ? 'fecha' : 'mes', ...keys.map((k) => `${k}_${UNITS[k] || ''}`.replace(/_$/, ''))].join(',')];
      for (let i = 0; i < n; i++) {
        const when = kind === 'h' ? hourAt(G, i).toISOString().slice(0, 16).replace('T', ' ') : kind === 'd' ? dayAt(G, i).toISOString().slice(0, 10) : CL.mKey(CL.mIdx(G.history.m0) + i);
        const vals = keys.map((k) => (block.vars[k][i] === null || block.vars[k][i] === undefined ? '' : block.vars[k][i]));
        if (vals.every((v) => v === '')) continue;
        lines.push([when, ...vals].join(','));
      }
      const text = `# ${t('agua.gaugeSource')}\n# ${G.name} (AEMET ${G.id})\n${lines.join('\n')}\n`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      a.download = `aemet-${G.id}-${{ h: 'horas', d: 'dias', m: 'meses' }[kind]}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    function openGauge(id, fromList) {
      st.gauge = id;
      st.res = null;
      restylePoints();
      const x = st.gauges.get(id);
      if (x && fromList) map.setView(x.m.getLatLng(), Math.max(9, map.getZoom()));
      render();
      dom.panel.scrollTop = 0;
      loadGauge(id).then(() => { if (st.gauge === id) render(); });
    }

    function closeGauge() {
      st.gauge = null;
      restylePoints();
      render();
    }

    // Buscador fijo arriba; el resto (el.body) se repinta.
    function shell() {
      if (st.shell) return st.shell;
      dom.panel.innerHTML = `<div class="agua-search"><input type="search" autocomplete="off" spellcheck="false"><ol class="agua-found" hidden></ol></div><div class="agua-body"></div>`;
      const input = dom.panel.querySelector('.agua-search input');
      const found = dom.panel.querySelector('.agua-found');
      input.addEventListener('input', () => { st.query = input.value; renderFound(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.value = ''; st.query = ''; renderFound(); }
        if (e.key === 'Enter') { const first = found.querySelector('[data-res]'); if (first) first.click(); }
      });
      st.shell = { input, found, body: dom.panel.querySelector('.agua-body') };
      return st.shell;
    }

    function renderFound() {
      const { input, found } = shell();
      input.placeholder = t('agua.search');
      input.setAttribute('aria-label', t('agua.search'));
      const q = fold(st.query.trim());
      if (!q || !st.data || !st.data.reservoirs) { found.hidden = true; found.innerHTML = ''; return; }
      const hits = [];
      for (const [id, b] of Object.entries(st.data.reservoirs.basins)) {
        for (const x of b.list || []) { const f = fold(x.name); const at = f.indexOf(q); if (at >= 0) hits.push({ id, x, score: at === 0 ? 0 : 1 }); }
      }
      hits.sort((a, b) => a.score - b.score || b.x.cap - a.x.cap);
      found.hidden = false;
      found.innerHTML = hits.length
        ? hits.slice(0, 8).map(({ id, x }) => `<li><button type="button" data-res="${esc(x.name)}" data-basin="${id}"><span>${esc(x.name)}</span><small>${esc(basinName(CU.basins.find((b) => b.id === id)))} · ${num(resPct(x), 0)} %</small></button></li>`).join('')
        : `<li class="hint">${esc(t('agua.searchNone'))}</li>`;
    }

    function render() {
      if (!st.open) return;
      const el = shell().body;
      renderFound();
      if (!st.data) {
        el.innerHTML = `<p class="hint agua-msg">${esc(st.error ? t('agua.error') : t('agua.loading'))}</p>`;
        return;
      }
      const updated = st.data.rain && st.data.rain.until;
      if (st.res) {
        el.innerHTML = `<section class="agua-resview">${renderRes()}</section>`;
        drawCharts(el);
        return;
      }
      if (st.gauge) {
        el.innerHTML = `<section class="agua-resview">${renderGauge()}</section>`;
        drawGaugeCharts(el);
        return;
      }
      el.innerHTML = `
        <section class="agua-total">${renderTotal()}</section>
        <section class="agua-controls">
          <div class="seg" role="group" aria-label="${esc(t('agua.colorBy'))}">
            <button type="button" data-color="reserve" aria-pressed="${st.color === 'reserve'}">${esc(t('agua.colorReserve'))}</button>
            <button type="button" data-color="rain" aria-pressed="${st.color === 'rain'}">${esc(t('agua.colorRain'))}</button>
          </div>
          <div class="seg small" role="group" aria-label="${esc(t('agua.period'))}">
            ${PERIODS.map((p) => `<button type="button" data-period="${p}" aria-pressed="${st.period === p}">${esc(t('agua.p.' + p))}</button>`).join('')}
          </div>
          ${st.color === 'rain' && st.surface && gaugeRows().length ? `<div class="seg small" role="group" aria-label="${esc(t('agua.rainView'))}">
            <button type="button" data-rview="surface" aria-pressed="${st.rainView === 'surface'}">${esc(t('agua.rv.surface'))}</button>
            <button type="button" data-rview="basins" aria-pressed="${st.rainView === 'basins'}">${esc(t('agua.rv.basins'))}</button>
          </div>` : ''}
        </section>
        ${st.color === 'rain' && gaugeRows().length ? `<section class="agua-pluvio">${renderGauges()}</section>` : ''}
        ${st.selected ? `<section class="agua-detail">${renderDetail(st.selected)}</section>` : ''}
        <section class="agua-basins">
          <div class="agua-list-head"><span>${esc(t('agua.basins'))}</span><span>${esc(t('agua.colReserve'))}</span><span>${esc(t('agua.colRain', { period: t('agua.p.' + st.period) }))}</span></div>
          <ol class="agua-list">${renderList()}</ol>
          <p class="hint">${esc(t('agua.clickHint'))}</p>
        </section>
        <footer class="agua-sources">
          <p>${esc(t('agua.sources'))}</p>
          ${updated ? `<p>${esc(t('agua.rainUntil', { time: new Date(updated).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }))}</p>` : ''}
        </footer>`;
      drawCharts(el);
    }

    // Gráficas, una vez el panel tiene tamaño.
    function drawCharts(el) {
      const r = st.data.reservoirs;
      const span = (dates) => [monthYear(dates[0]), monthYear(dates[dates.length - 1])];
      const labels = r && r.weekDates ? span(r.weekDates) : null;
      const monthLabels = (m0, n) => [m0.slice(0, 4), String(+m0.slice(0, 4) + Math.floor((+m0.slice(5, 7) - 1 + n - 1) / 12))];
      const H = st.res && histOf(st.res.id) ? histOf(st.res.id).res[st.res.name] : null;
      el.querySelectorAll('canvas[data-chart]').forEach((c) => {
        const kind = c.dataset.chart;
        if (kind === 'total') chartLine(c, r.total.weeks, r.total.weeksAvg, labels);
        else if (kind === 'basin') { const x = res(st.selected); chartLine(c, x.weeks, x.weeksAvg, labels); }
        else if (kind === 'basin-months') { const tt = histOf(st.selected).total; chartLine(c, tt.m, null, monthLabels(tt.m0, tt.m.length), { fixed: true, thin: true }); }
        else if (kind === 'rain') chartBars(c, rainOf(st.selected).serie);
        else if (kind === 'res-year' && H) chartLine(c, H.w, H.avg, span(histOf(st.res.id).weekDates), { fixed: true, band: [H.lo, H.hi] });
        else if (kind === 'res-years' && H) chartYears(c, H.yrs.concat([H.w[H.w.length - 1]]), H.y0);
        else if (kind === 'res-months' && H) chartLine(c, H.m, null, monthLabels(H.m0, H.m.length), { fixed: true, thin: true });
      });
    }

    dom.panel.addEventListener('click', (e) => {
      const color = e.target.closest('[data-color]');
      if (color) { st.color = color.dataset.color; restyleAll(); render(); return; }
      const period = e.target.closest('[data-period]');
      if (period) { st.period = period.dataset.period; if (st.color !== 'rain') st.color = 'rain'; restyleAll(); render(); return; }
      if (e.target.closest('[data-close]')) { select(null); return; }
      if (e.target.closest('[data-res-back]')) { closeRes(); return; }
      const gb = e.target.closest('[data-gauge]');
      if (gb) { openGauge(gb.dataset.gauge, true); return; }
      if (e.target.closest('[data-gauge-back]')) { closeGauge(); return; }
      const gv = e.target.closest('[data-gvar]');
      if (gv) { st.gaugeVar = gv.dataset.gvar; render(); return; }
      const csv = e.target.closest('[data-csv]');
      if (csv) { downloadCsv(csv.dataset.csv); return; }
      const rv = e.target.closest('[data-rview]');
      if (rv) { st.rainView = rv.dataset.rview; restyleAll(); render(); return; }
      const rb = e.target.closest('[data-res]');
      if (rb) { openRes(rb.dataset.basin, rb.dataset.res, true); return; }
      const row = e.target.closest('.agua-row');
      if (row) select(row.dataset.id, true);
    });

    dom.panel.addEventListener('pointermove', hover);
    dom.panel.addEventListener('pointerdown', hover);
    dom.panel.addEventListener('pointerleave', hover, true);
    // Secciones plegables de la ficha: recordar si están abiertas y dibujar las gráficas al abrirlas.
    dom.panel.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d.dataset || !d.dataset.sec) return;
      st.gOpen.set(d.dataset.sec, d.open);
      if (d.open) drawGaugeCharts(dom.panel);
    }, true);

    function openRes(id, name, fromList) {
      const prevBasin = st.selected;
      st.res = { id, name };
      st.gauge = null;
      st.selected = id;
      if (prevBasin && prevBasin !== id) restyle(prevBasin);
      restyle(id);
      restylePoints();
      const { input } = shell();
      if (st.query) { input.value = ''; st.query = ''; }
      const it = inv(id, name);
      if (it && fromList) map.setView([it.lat, it.lon], Math.max(9, map.getZoom()));
      render();
      dom.panel.scrollTop = 0;
      loadHist(id).then(() => { if (st.res && st.res.id === id) render(); });
    }

    function closeRes() {
      const id = st.res && st.res.id;
      st.res = null;
      restylePoints();
      render();
      if (id && st.shapes.get(id)) map.fitBounds(st.shapes.get(id).shape.getBounds(), { padding: [30, 30], maxZoom: 8 });
      const d = dom.panel.querySelector('.agua-detail');
      if (d) d.scrollIntoView({ block: 'start' });
    }

    function select(id, fromList) {
      const prev = st.selected;
      st.selected = st.selected === id ? null : id;
      st.gauge = null;
      if (prev) restyle(prev);
      st.res = null;
      restylePoints();
      if (st.selected) {
        restyle(st.selected);
        if (fromList) map.fitBounds(st.shapes.get(st.selected).shape.getBounds(), { padding: [30, 30], maxZoom: 8 });
        const id = st.selected;
        if (res(id)) loadHist(id).then(() => { if (st.selected === id && !st.res) render(); }); // sin embalses, sin histórico
      }
      render();
      if (st.selected) { const d = dom.panel.querySelector('.agua-detail'); if (d) d.scrollIntoView({ block: 'nearest' }); }
    }

    async function open() {
      if (st.open) return;
      st.open = true;
      setAttribution(attribution());
      buildLayer();
      st.prevView = { center: map.getCenter(), zoom: map.getZoom() };
      st.layer.addTo(map);
      st.pointLayer.addTo(map);
      map.fitBounds(SPAIN, { padding: [10, 10] });
      renderZone('peninsula');
      zoneEl.hidden = false;
      onZoom();
      render();
      await load();
      buildPoints();
      buildGauges();
      restyleAll();
      render();
    }

    function close() {
      if (!st.open) return;
      st.open = false;
      zoneEl.hidden = true;
      setAttribution(null);
      map.removeLayer(st.layer);
      map.removeLayer(st.pointLayer);
      map.removeLayer(st.gaugeLayer);
      if (st.surface) map.removeLayer(st.surface);
      st.gauge = null;
      map.getContainer().classList.remove('agua-near');
      st.res = null;
      for (const s of st.shapes.values()) s.label.remove();
      if (st.prevView) map.setView(st.prevView.center, st.prevView.zoom);
    }

    return {
      open, close,
      isOpen: () => st.open,
      refresh() { if (st.open) { setAttribution(attribution()); renderZone(); restyleAll(); render(); } },
      reload() { if (st.open) load(true).then(() => { buildPoints(); buildGauges(); restyleAll(); render(); }); }
    };
  }

  window.RA_AGUA = { create };
})();
