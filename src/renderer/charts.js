/* Gráficas SVG sencillas para el panel lateral. */
(function () {
  'use strict';
  const P = window.RA_PALETTE;
  const D = window.RA_DESCRIBE;
  const F = window.RA_FORECAST;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function niceMax(v, floor) {
    const steps = [1, 2, 5, 10, 20, 50, 100, 200];
    const target = Math.max(v, floor);
    return steps.find((s) => s >= target) || target;
  }

  function rateLabel(t, v, units) {
    if (units.rate === 'in') return `${+(v / 25.4).toFixed(2)} in/h`;
    return `${v} mm/h`;
  }

  /**
   * Próximas 2 horas, previsión combinada (radar al principio, modelo
   * después): barras con la intensidad esperada cada 5 min (más claras donde
   * manda el modelo), línea de probabilidad (0–100 %) y franja con el margen
   * de la hora de llegada.
   */
  function chart2h(el, { status, settings, t, loc }) {
    const W = 336, H = 124, L = 4, R = 4, T = 16, B = 18;
    const pw = W - L - R, ph = H - T - B;
    const units = settings.units;
    const now = Date.now();
    const radar = status && status.radar && status.radar.ok ? status.radar : null;
    const thr = P.LEVELS[(loc && loc.alarm && loc.alarm.level) || 'light'];
    const ol = F.blend(status, loc, { now, horizonMin: 120 });
    const series = ol ? ol.series : [];
    const stepMin = ol ? ol.stepMin : 5;
    const rateMax = series.reduce((a, s) => Math.max(a, s.known ? s.rate : 0), 0);
    const thrRate = P.dbzToRate(thr, P.KIND_RAIN);
    const max = niceMax(rateMax * 1.1, 2);
    const x = (min) => L + (min / 120) * pw;
    const y = (rate) => T + ph - Math.sqrt(Math.min(rate, max) / max) * ph;
    const yP = (p) => T + ph - p * ph;
    const minOf = (s) => (s.ts - now) / 60000;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('ui.next2h'))}">`;
    for (const g of [0.25, 0.5, 1]) {
      const v = max * g * g; // escala raíz: líneas en valores "redondos" de la raíz
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    }
    svg += `<text class="axis" x="${L}" y="${T - 5}">${esc(rateLabel(t, max, units))}</text>`;
    svg += `<text class="axis" x="${W - R}" y="${T - 5}" text-anchor="end">100 %</text>`;

    // Margen de la hora de llegada
    if (ol && ol.eta && ol.eta.early !== null && ol.eta.min <= 120) {
      const a = Math.max(0, ol.eta.early - stepMin / 2);
      const b = Math.min(120, (ol.eta.late !== null ? ol.eta.late : ol.eta.min) + stepMin / 2);
      svg += `<rect class="eta-band" x="${x(a).toFixed(1)}" y="${T}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${ph}" rx="2"/>`;
    }

    // Umbral de la alarma
    if (thrRate < max) {
      svg += `<line class="threshold" x1="${L}" x2="${W - R}" y1="${y(thrRate).toFixed(1)}" y2="${y(thrRate).toFixed(1)}"/>`;
    }

    // Barras
    const bw = (stepMin / 120) * pw;
    for (const s of series) {
      const tm = minOf(s);
      const x0 = x(Math.max(0, tm - stepMin / 2));
      const x1 = x(Math.min(120, tm + stepMin / 2));
      const width = Math.max(0.5, Math.min(bw, x1 - x0) - 1).toFixed(1);
      if (!s.known) {
        svg += `<rect class="unknown" x="${x0.toFixed(1)}" y="${(T + ph - 2).toFixed(1)}" width="${width}" height="2"/>`;
        continue;
      }
      if (!(s.rate > 0.05) || s.dbz === null) continue;
      const yy = y(s.rate);
      svg += `<rect class="bar ${s.src === 'model' ? 'from-model' : ''}" x="${x0.toFixed(1)}" y="${yy.toFixed(1)}" width="${width}" height="${(T + ph - yy).toFixed(1)}" fill="${P.cssFor(Math.max(10, s.dbz), s.kind)}" rx="1"/>`;
    }

    // Probabilidad
    let d = '';
    let pen = false;
    for (const s of series) {
      if (!s.known) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(Math.max(0, minOf(s))).toFixed(1)},${yP(s.p).toFixed(1)}`;
      pen = true;
    }
    if (d) svg += `<path class="prob-halo" d="${d}"/><path class="prob p2h" d="${d}"/>`;

    // Eje X
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`;
    for (const m of [0, 30, 60, 90, 120]) {
      const label = m === 0 ? t('ui.now') : D.fmtClock(t, now + m * 60000);
      const anchor = m === 0 ? 'start' : m === 120 ? 'end' : 'middle';
      svg += `<text class="axis" x="${x(m).toFixed(1)}" y="${H - 4}" text-anchor="${anchor}">${esc(label)}</text>`;
    }
    svg += '</svg>';
    el.innerHTML = svg;
    return { hasMotion: !!(radar && radar.motion), hasRadar: !!radar };
  }

  /**
   * Versión compacta de las próximas 2 horas para el widget: mismas barras,
   * probabilidad y margen de llegada, dibujada al tamaño real del hueco
   * (`width` × `height` px) para que el texto no se encoja. Con `labels`,
   * horas debajo (ahora, +1 h, +2 h).
   */
  function chartCompact(el, { status, loc, t, width, height, labels = true }) {
    const W = Math.max(60, Math.round(width)), H = Math.max(24, Math.round(height));
    const B = labels ? 14 : 0, T = 2;
    const ph = H - T - B;
    const now = Date.now();
    const ol = F.blend(status, loc, { now, horizonMin: 120 });
    const series = ol ? ol.series : [];
    const stepMin = ol ? ol.stepMin : 5;
    const max = niceMax(series.reduce((a, s) => Math.max(a, s.known ? s.rate : 0), 0) * 1.1, 2);
    const x = (min) => (min / 120) * W;
    const y = (rate) => T + ph - Math.sqrt(Math.min(rate, max) / max) * ph;
    const yP = (p) => T + ph - p * ph;
    const minOf = (s) => (s.ts - now) / 60000;

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(t('ui.next2h'))}">`;
    if (ol && ol.eta && ol.eta.early !== null && ol.eta.min <= 120) {
      const a = Math.max(0, ol.eta.early - stepMin / 2);
      const b = Math.min(120, (ol.eta.late !== null ? ol.eta.late : ol.eta.min) + stepMin / 2);
      svg += `<rect class="eta-band" x="${x(a).toFixed(1)}" y="${T}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${ph}" rx="2"/>`;
    }
    const bw = (stepMin / 120) * W;
    for (const s of series) {
      if (!s.known || !(s.rate > 0.05) || s.dbz === null) continue;
      const tm = minOf(s);
      const x0 = x(Math.max(0, tm - stepMin / 2));
      const yy = y(s.rate);
      svg += `<rect class="bar ${s.src === 'model' ? 'from-model' : ''}" x="${x0.toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.max(0.5, bw - 1).toFixed(1)}" height="${(T + ph - yy).toFixed(1)}" fill="${P.cssFor(Math.max(10, s.dbz), s.kind)}" rx="1"/>`;
    }
    let d = '';
    let pen = false;
    for (const s of series) {
      if (!s.known) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(Math.max(0, minOf(s))).toFixed(1)},${yP(s.p).toFixed(1)}`;
      pen = true;
    }
    if (d) svg += `<path class="prob p2h" d="${d}"/>`;
    svg += `<line class="grid" x1="0" x2="${W}" y1="${(T + ph).toFixed(1)}" y2="${(T + ph).toFixed(1)}"/>`;
    if (labels) {
      for (const [m, anchor] of [[0, 'start'], [60, 'middle'], [120, 'end']]) {
        const label = m === 0 ? t('ui.now') : D.fmtClock(t, now + m * 60000);
        svg += `<text class="axis" x="${x(m).toFixed(1)}" y="${H - 2}" text-anchor="${anchor}">${esc(label)}</text>`;
      }
    }
    el.innerHTML = svg + '</svg>';
  }

  /** Próximas 24 horas: mm por hora (barras) y probabilidad (línea). */
  function chart24h(el, { status, settings, t }) {
    const W = 336, H = 112, L = 4, R = 4, T = 16, B = 18;
    const pw = W - L - R, ph = H - T - B;
    const model = status && status.model && status.model.ok ? status.model : null;
    if (!model || !model.hourly.length) {
      el.innerHTML = `<p class="hint">${esc(t('ui.noModel'))}</p>`;
      return;
    }
    const now = Date.now();
    const hours = model.hourly.filter((h) => h.t > now - 60 * 60000).slice(0, 24);
    const units = settings.units;
    const maxMm = niceMax(hours.reduce((a, h) => Math.max(a, h.precip || 0), 0) * 1.1, 2);
    const n = hours.length;
    const bw = pw / n;
    const x = (i) => L + i * bw;
    const yMm = (v) => T + ph - (Math.min(v, maxMm) / maxMm) * ph;
    const yP = (p) => T + ph - (p / 100) * ph;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('ui.next24h'))}">`;
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${T}" y2="${T}"/>`;
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${T + ph / 2}" y2="${T + ph / 2}"/>`;
    const mmLabel = units.rate === 'in' ? `${+(maxMm / 25.4).toFixed(2)} in` : `${maxMm} mm`;
    svg += `<text class="axis" x="${L}" y="${T - 5}">${esc(mmLabel)}</text>`;
    svg += `<text class="axis" x="${W - R}" y="${T - 5}" text-anchor="end">100 % ${esc(t('ui.probability').toLowerCase())}</text>`;

    // Probabilidad (área + línea)
    const pts = hours.map((h, i) => [x(i) + bw / 2, yP(h.prob || 0)]);
    if (pts.length) {
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      svg += `<path class="prob-area" d="${line}L${pts[pts.length - 1][0].toFixed(1)},${T + ph}L${pts[0][0].toFixed(1)},${T + ph}Z"/>`;
      svg += `<path class="prob" d="${line}"/>`;
    }
    // Barras de mm y tormentas previstas (⚡)
    hours.forEach((h, i) => {
      const v = h.precip || 0;
      const yy = yMm(v);
      if (v > 0) svg += `<rect class="bar-model" x="${(x(i) + 1.5).toFixed(1)}" y="${yy.toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${(T + ph - yy).toFixed(1)}" rx="1"/>`;
      if (h.code === 95 || h.code === 96 || h.code === 99) {
        const bx = x(i) + bw / 2 - 3.6, by = Math.min(yy, T + ph) - 13;
        svg += `<path class="storm" transform="translate(${bx.toFixed(1)},${by.toFixed(1)}) scale(0.6)" d="M7.4.5 1.3 9.1h4l-1.2 6.4 6.6-8.9H6.6L7.4.5Z"/>`;
      }
    });
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`;
    hours.forEach((h, i) => {
      const d = new Date(h.t);
      if (d.getHours() % 3 !== 0) return;
      const label = new Intl.DateTimeFormat(t.lang === 'es' ? 'es-ES' : 'en-GB', { hour: '2-digit' }).format(d);
      svg += `<text class="axis" x="${(x(i) + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(label)}h</text>`;
    });
    svg += '</svg>';
    el.innerHTML = svg;
  }

  window.RA_CHARTS = { chart2h, chartCompact, chart24h };
})();
