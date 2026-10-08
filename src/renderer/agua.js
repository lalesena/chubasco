/* Agua en España: reserva de los embalses y lluvia por cuenca hidrográfica.
 * Panel lateral, capa de cuencas y puntos de los embalses en el mapa, y la
 * ficha de cada embalse, y los pluviómetros de AEMET. Los datos (agua.json,
 * pluvio.json y el histórico de cada cuenca, embalses/<id>.json) los publica
 * la web cada hora; aquí solo se muestran.
 * La ubicación y los datos de cada presa vienen de shared/embalses.js. */
(function () {
  'use strict';
  const L = window.L;
  const CU = window.RA_CUENCAS;
  const EM = () => window.RA_EMBALSES || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SPAIN = [[35.9, -9.4], [43.9, 4.4]];
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
      pluvio: null, gauges: new Map(), gaugeLayer: L.layerGroup()
    };
    map.createPane('agua').style.zIndex = 330;
    map.createPane('aguapoints').style.zIndex = 335;
    map.createPane('aguagauges').style.zIndex = 336;
    // Al acercarse vuelven los nombres del mapa base (ver styles.css).
    const onZoom = () => {
      if (!st.open) return;
      map.getContainer().classList.toggle('agua-near', map.getZoom() >= NEAR_ZOOM);
      for (const id of st.shapes.keys()) restyle(id);
    };
    map.on('zoomend', onZoom);
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
      if (inches()) return `${num(mm / 25.4, 2)} in`;
      return `${num(mm, mm < 10 ? 1 : 0)} mm`;
    };
    const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), 1);
    const dateText = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
    const monthYear = (iso) => new Date(iso.slice(0, 7) + '-15T12:00:00Z').toLocaleDateString(locale(), { month: 'short', year: 'numeric' });
    const basinName = (b) => (getT().lang === 'es' ? b.name : b.nameEn);

    // CC BY 4.0 (OPERA, AEMA) y aviso legal de MITECO: citar la fuente.
    const attribution = () => [
      `${esc(t('agua.attrReservoirs'))} <a href="https://www.miteco.gob.es/es/agua/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico.html">MITECO</a>`,
      `${esc(t('agua.attrRain'))} <a href="https://www.eumetnet.eu/">EUMETNET</a> OPERA (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, ${esc(t('map.processed'))})`,
      `${esc(t('agua.attrBasins'))} <a href="https://www.eea.europa.eu/">AEMA</a> (CC BY 4.0)`,
      // Nota legal de AEMET: citarla como fuente («© AEMET»).
      ...(st.pluvio ? [`${esc(t('agua.attrGauges'))} © <a href="https://www.aemet.es/">AEMET</a>`] : [])
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
      s.shape.setStyle({ fillColor: colorOf(v), weight: sel ? 3 : 1, color: sel ? '#14212b' : '#ffffff', fillOpacity: v === null || v === undefined ? 0.25 : near ? 0.22 : 0.72 });
      if (sel) s.shape.bringToFront();
      const text = labelOf(v);
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

    // Pluviómetros: [id, nombre, lat, lon, 1 h, 24 h, 7 días, 30 días].
    const GAUGE_COL = { h24: 5, d7: 6, d30: 7 };
    const gaugeValue = (g) => (GAUGE_COL[st.period] ? g[GAUGE_COL[st.period]] : null);
    const gaugeRows = () => (st.pluvio && st.pluvio.stations) || [];

    function buildGauges() {
      st.gaugeLayer.clearLayers();
      st.gauges.clear();
      for (const g of gaugeRows()) {
        const m = L.circleMarker([g[2], g[3]], { pane: 'aguagauges', radius: 4.5, weight: 1, color: '#14212b', opacity: 0.55, fillOpacity: 0.95, bubblingMouseEvents: false });
        m.bindTooltip(() => {
          const v = gaugeValue(g);
          return `<strong>${esc(g[1])}</strong><br>${v !== null ? `${esc(t('agua.p.' + st.period))}: ${esc(rain(v))} · ` : ''}${esc(t('agua.gaugesLastHour'))}: ${esc(rain(g[4]))}`;
        }, { direction: 'top', className: 'agua-tip', offset: [0, -4] });
        st.gauges.set(g[0], { m, g });
      }
    }

    // En «Lluvia», los pluviómetros con dato para el periodo; en «Reserva», los embalses.
    function restyleGauges() {
      const show = st.open && st.color === 'rain';
      if (show) { map.removeLayer(st.pointLayer); st.gaugeLayer.addTo(map); } else { map.removeLayer(st.gaugeLayer); if (st.open) st.pointLayer.addTo(map); }
      const steps = RAIN_STEPS[st.period];
      for (const { m, g } of st.gauges.values()) {
        const v = gaugeValue(g);
        if (!show || v === null || v === undefined) { st.gaugeLayer.removeLayer(m); continue; }
        m.setStyle({ fillColor: RAIN_COLORS[classOf(v, steps)] });
        st.gaugeLayer.addLayer(m);
      }
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
      let list = withValue, key = col, title = t('agua.gaugesTop', { period: t('agua.p.' + st.period) });
      if (!col) html += `<p class="hint">${esc(t('agua.gaugesYear'))}</p>`;
      if (!list.length) { list = rows; key = 4; title = t('agua.gaugesTop', { period: t('agua.gaugesLastHour').toLowerCase() }); if (col) html += `<p class="hint">${esc(t('agua.gaugesWaiting', { period: t('agua.p.' + st.period) }))}</p>`; }
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
        html += `<h3>${esc(t('agua.rain'))}</h3>
          <dl class="agua-rain">
            ${PERIODS.map((p) => `<div><dt>${esc(t('agua.p.' + p))}</dt><dd>${esc(rain(rn[p]))}</dd></div>`).join('')}
          </dl>
          ${fallen !== null ? `<p class="agua-deltas">${esc(t('agua.fallen', { hm3: num(fallen) }))}</p>` : ''}
          ${rn.cover !== null && rn.cover < 0.8 ? `<p class="hint">${esc(t('agua.partial', { pct: Math.round(rn.cover * 100) }))}</p>` : ''}
          ${rn.serie ? `<canvas class="agua-chart bars" data-chart="rain"></canvas><p class="hint">${esc(t('agua.daily30'))}</p>` : ''}`;
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
      if (gb) { const x = st.gauges.get(gb.dataset.gauge); if (x) { map.setView(x.m.getLatLng(), Math.max(9, map.getZoom())); x.m.openTooltip(); } return; }
      const rb = e.target.closest('[data-res]');
      if (rb) { openRes(rb.dataset.basin, rb.dataset.res, true); return; }
      const row = e.target.closest('.agua-row');
      if (row) select(row.dataset.id, true);
    });

    function openRes(id, name, fromList) {
      const prevBasin = st.selected;
      st.res = { id, name };
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
      if (prev) restyle(prev);
      st.res = null;
      restylePoints();
      if (st.selected) {
        restyle(st.selected);
        if (fromList) map.fitBounds(st.shapes.get(st.selected).shape.getBounds(), { padding: [30, 30], maxZoom: 8 });
        const id = st.selected;
        loadHist(id).then(() => { if (st.selected === id && !st.res) render(); });
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
      setAttribution(null);
      map.removeLayer(st.layer);
      map.removeLayer(st.pointLayer);
      map.removeLayer(st.gaugeLayer);
      map.getContainer().classList.remove('agua-near');
      st.res = null;
      for (const s of st.shapes.values()) s.label.remove();
      if (st.prevView) map.setView(st.prevView.center, st.prevView.zoom);
    }

    return {
      open, close,
      isOpen: () => st.open,
      refresh() { if (st.open) { setAttribution(attribution()); restyleAll(); render(); } },
      reload() { if (st.open) load(true).then(() => { buildPoints(); buildGauges(); restyleAll(); render(); }); }
    };
  }

  window.RA_AGUA = { create };
})();
