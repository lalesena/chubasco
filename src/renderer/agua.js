/* Agua en España: reserva de los embalses y lluvia por cuenca hidrográfica.
 * Panel lateral y capa de cuencas en el mapa. Los datos (agua.json) los
 * publica la web cada hora; aquí solo se muestran. */
(function () {
  'use strict';
  const L = window.L;
  const CU = window.RA_CUENCAS;
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

  function create({ map, api, dom, getT, getUnits, setAttribution = () => {} }) {
    const st = {
      open: false, data: null, loadedAt: 0, error: null, loading: null,
      color: 'reserve', period: 'd7', selected: null, prevView: null,
      layer: L.layerGroup(), shapes: new Map()
    };
    map.createPane('agua').style.zIndex = 330;
    const labelsPane = map.createPane('agualabels');
    labelsPane.style.zIndex = 340;
    labelsPane.style.pointerEvents = 'none';

    const t = (k, v) => getT()(k, v);
    const locale = () => (getT().lang === 'es' ? 'es-ES' : 'en-GB');
    const num = (v, d = 0) => (v === null || v === undefined ? '—' : v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }));
    const pct = (v) => (v === null || v === undefined ? '—' : `${num(v, 1)} %`);
    const inches = () => getUnits().rate === 'in';
    const rain = (mm) => {
      if (mm === null || mm === undefined) return '—';
      if (inches()) return `${num(mm / 25.4, 2)} in`;
      return `${num(mm, mm < 10 ? 1 : 0)} mm`;
    };
    const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), 1);
    const dateText = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
    const basinName = (b) => (getT().lang === 'es' ? b.name : b.nameEn);

    // CC BY 4.0 (OPERA, AEMA) y aviso legal de MITECO: citar la fuente.
    const attribution = () => [
      `${esc(t('agua.attrReservoirs'))} <a href="https://www.miteco.gob.es/es/agua/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico.html">MITECO</a>`,
      `${esc(t('agua.attrRain'))} <a href="https://www.eumetnet.eu/">EUMETNET</a> OPERA (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, ${esc(t('map.processed'))})`,
      `${esc(t('agua.attrBasins'))} <a href="https://www.eea.europa.eu/">AEMA</a> (CC BY 4.0)`
    ].join(' · ');

    // ----------------------------------------------------------------
    // Datos

    async function load(force) {
      if (st.loading) return st.loading;
      if (!force && st.data && Date.now() - st.loadedAt < 10 * 60000) return st.data;
      st.loading = api.agua().then((d) => {
        st.data = d; st.loadedAt = Date.now(); st.error = null;
        return d;
      }).catch((e) => { st.error = e.message || String(e); return st.data; })
        .finally(() => { st.loading = null; });
      return st.loading;
    }

    const res = (id) => (st.data && st.data.reservoirs && st.data.reservoirs.basins[id]) || null;
    const rainOf = (id) => (st.data && st.data.rain && st.data.rain.basins[id]) || null;

    function valueOf(id) {
      if (st.color === 'reserve') { const r = res(id); return r ? r.pct : null; }
      const r = rainOf(id);
      return r ? r[st.period] : null;
    }
    function colorOf(v) {
      if (v === null || v === undefined) return NO_DATA;
      return st.color === 'reserve' ? RESERVE.colors[classOf(v, RESERVE.steps)] : RAIN_COLORS[classOf(v, RAIN_STEPS[st.period])];
    }
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
      s.shape.setStyle({ fillColor: colorOf(v), weight: sel ? 3 : 1, color: sel ? '#14212b' : '#ffffff', fillOpacity: v === null || v === undefined ? 0.25 : 0.72 });
      if (sel) s.shape.bringToFront();
      const text = labelOf(v);
      s.label.setContent(text);
      if (text && st.open) s.label.addTo(map); else s.label.remove();
    }
    function restyleAll() { for (const id of st.shapes.keys()) restyle(id); renderLegend(); }

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

    function chartLine(canvas, values, avg, labels) {
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
      const lo = Math.max(0, Math.floor((Math.min(...all) - 5) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...all) + 5) / 10) * 10);
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
      if (avg) draw(avg, ink, 1.2, [3, 3]);
      draw(values, accent, 2);
      if (labels) {
        ctx.fillStyle = ink;
        ctx.fillText(labels[0], pad.l, h - 3);
        const tw = ctx.measureText(labels[1]).width;
        ctx.fillText(labels[1], w - pad.r - tw, h - 3);
      }
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
          html += `<li><span class="name">${esc(x.name)}${x.elec ? ` <small>${esc(t('agua.hydro'))}</small>` : ''}</span>
            <span class="bar" aria-hidden="true"><span style="width:${Math.min(100, p)}%"></span></span>
            <span class="val">${num(p, 0)} %</span>
            <span class="vol">${num(x.vol)}/${num(x.cap)} hm³${dv ? ` <em class="${dv > 0 ? 'up' : 'down'}">${dv > 0 ? '▲' : '▼'}${num(Math.abs(dv))}</em>` : ''}</span></li>`;
        }
        html += '</ol>';
      }
      return html;
    }

    function render() {
      if (!st.open) return;
      const el = dom.panel;
      if (!st.data) {
        el.innerHTML = `<p class="hint agua-msg">${esc(st.error ? t('agua.error') : t('agua.loading'))}</p>`;
        return;
      }
      const updated = st.data.rain && st.data.rain.until;
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
      // Gráficas, una vez el panel tiene tamaño.
      const r = st.data.reservoirs;
      const labels = r && r.weekDates ? [dateText(r.weekDates[0]).replace(/ de /, ' '), dateText(r.weekDates[r.weekDates.length - 1]).replace(/ de /, ' ')] : null;
      el.querySelectorAll('canvas[data-chart]').forEach((c) => {
        const kind = c.dataset.chart;
        if (kind === 'total') chartLine(c, r.total.weeks, r.total.weeksAvg, labels);
        else if (kind === 'basin') { const x = res(st.selected); chartLine(c, x.weeks, x.weeksAvg, labels); }
        else if (kind === 'rain') chartBars(c, rainOf(st.selected).serie);
      });
    }

    dom.panel.addEventListener('click', (e) => {
      const color = e.target.closest('[data-color]');
      if (color) { st.color = color.dataset.color; restyleAll(); render(); return; }
      const period = e.target.closest('[data-period]');
      if (period) { st.period = period.dataset.period; if (st.color !== 'rain') st.color = 'rain'; restyleAll(); render(); return; }
      if (e.target.closest('[data-close]')) { select(null); return; }
      const row = e.target.closest('.agua-row');
      if (row) select(row.dataset.id, true);
    });

    function select(id, fromList) {
      const prev = st.selected;
      st.selected = st.selected === id ? null : id;
      if (prev) restyle(prev);
      if (st.selected) {
        restyle(st.selected);
        if (fromList) map.fitBounds(st.shapes.get(st.selected).shape.getBounds(), { padding: [30, 30], maxZoom: 8 });
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
      map.fitBounds(SPAIN, { padding: [10, 10] });
      render();
      await load();
      restyleAll();
      render();
    }

    function close() {
      if (!st.open) return;
      st.open = false;
      setAttribution(null);
      map.removeLayer(st.layer);
      for (const s of st.shapes.values()) s.label.remove();
      if (st.prevView) map.setView(st.prevView.center, st.prevView.zoom);
    }

    return {
      open, close,
      isOpen: () => st.open,
      refresh() { if (st.open) { setAttribution(attribution()); restyleAll(); render(); } },
      reload() { if (st.open) load(true).then(() => { restyleAll(); render(); }); }
    };
  }

  window.RA_AGUA = { create };
})();
