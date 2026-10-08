// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/* Mini panel de la barra de menú: lo esencial de la ubicación activa. */
(function () {
  'use strict';
  const api = window.chubasco;
  const P = window.RA_PALETTE;
  const I = window.RA_I18N;
  const D = window.RA_DESCRIBE;
  const C = window.RA_CHARTS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const BOLT_ICON = '<svg class="bolt-icon" viewBox="0 0 12 16" aria-hidden="true"><path d="M7.4.5 1.3 9.1h4l-1.2 6.4 6.6-8.9H6.6L7.4.5Z"/></svg>';
  const WARN_ICON = '<svg class="warn-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1L8 1.8Z"/><path d="M8 6.2v3.6M8 11.6v.4"/></svg>';

  const S = { settings: null, locations: [], activeId: null, statuses: {}, systemLocale: 'es', t: I.make('es') };

  function active() { return S.locations.find((l) => l.id === S.activeId) || S.locations[0] || null; }

  function applyI18n() {
    const t = S.t;
    document.documentElement.lang = t.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
  }

  function render() {
    const t = S.t;
    const loc = active();
    const many = S.locations.length > 1;
    $('m-loc').hidden = !many;
    $('m-name').hidden = many;
    $('m-name').textContent = loc ? loc.name : t('ui.addLocation');
    if (many) {
      $('m-loc').innerHTML = S.locations.map((l) => `<option value="${esc(l.id)}"${l.id === (loc && loc.id) ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
    }
    for (const id of ['m-status', 'm-chart']) $(id).closest('section').hidden = !loc;
    if (!loc) { $('m-others').innerHTML = `<li class="hint">${esc(t('tray.noLocations'))}</li>`; resize(); return; }

    const st = S.statuses[loc.id];
    const d = D.describe(st, loc, S.settings, t);
    $('m-status').dataset.level = d.level;
    const meter = $('m-meter');
    meter.style.background = d.dbz !== null && d.dbz !== undefined ? P.cssFor(d.dbz, d.kind) : d.level === 'clear' ? '#5fb38a' : '';
    meter.style.width = d.level === 'raining' ? '96px' : d.level === 'imminent' ? '76px' : d.level === 'approaching' ? '64px' : '44px';
    $('m-headline').textContent = d.headline;
    $('m-detail').textContent = d.detail || '';
    $('m-outlook').textContent = d.outlook || '';
    $('m-lightning').innerHTML = d.lightning ? BOLT_ICON + esc(d.lightning) : '';
    $('m-severe').innerHTML = d.severe ? WARN_ICON + esc(d.severe) : '';
    const watching = !!loc.dryWatch;
    $('m-dry').hidden = !watching && d.level !== 'raining';
    $('m-dry-off').hidden = watching;
    $('m-dry-active').hidden = !watching;
    if (watching) $('m-dry-text').textContent = t('ui.dryWatch.active', { n: loc.dryWatch.minMin });

    C.chart2h($('m-chart'), { status: st, settings: S.settings, t, loc });

    $('m-others').innerHTML = '';
    for (const l of S.locations) {
      if (l.id === loc.id) continue;
      const od = D.describe(S.statuses[l.id], l, S.settings, t);
      const li = document.createElement('li');
      li.innerHTML = `<button type="button"><span class="dot" data-level="${esc(od.level)}"></span><span class="l-name">${esc(l.name)}</span><span class="l-head">${esc(od.headline)}</span></button>`;
      li.firstChild.addEventListener('click', () => select(l.id));
      $('m-others').appendChild(li);
    }

    const r = st && st.radar;
    $('m-meta').textContent = r && r.ok ? t('mini.radar', { time: D.fmtClock(t, r.frameTime * 1000) }) : '';
    const snoozed = S.settings.snoozeUntil > Date.now();
    $('m-snooze').textContent = snoozed ? t('ui.resume') : t('mini.snooze1');
    resize();
  }

  // El proceso principal ajusta la altura de la ventana al contenido.
  let lastH = 0;
  function resize() {
    requestAnimationFrame(() => {
      const h = Math.ceil($('mini').getBoundingClientRect().height);
      if (h !== lastH) { lastH = h; api.miniResize(h); }
    });
  }

  async function select(id) {
    S.activeId = id;
    await api.setActive(id);
    render();
  }

  async function init() {
    const st = await api.getState();
    Object.assign(S, { settings: st.settings, locations: st.locations, activeId: st.activeLocationId, statuses: st.statuses || {}, systemLocale: st.systemLocale });
    document.body.classList.add('platform-' + st.platform);
    S.t = I.make(I.resolveLang(S.settings.language, S.systemLocale));
    applyI18n();

    $('m-loc').addEventListener('change', (e) => select(e.target.value));
    $('m-open').addEventListener('click', () => api.showMain());
    $('m-check').addEventListener('click', () => api.checkNow());
    $('m-snooze').addEventListener('click', () => api.snooze(S.settings.snoozeUntil > Date.now() ? 0 : 60));
    $('m-dry-on').addEventListener('click', () => { const l = active(); if (l) api.dryWatch(l.id, Number($('m-dry-min').value)); });
    $('m-dry-cancel').addEventListener('click', () => { const l = active(); if (l) api.dryWatch(l.id, null); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.miniHide(); });

    api.on('status', (p) => { S.statuses = p.statuses || {}; render(); });
    api.on('locations', (p) => { S.locations = p.locations; S.activeId = p.activeLocationId; render(); });
    api.on('settings', (p) => {
      const lang = p.settings.language !== S.settings.language;
      S.settings = p.settings;
      if (lang) { S.t = I.make(I.resolveLang(S.settings.language, S.systemLocale)); applyI18n(); }
      render();
    });
    api.on('ui', (msg) => { if (msg && msg.action === 'mini-shown') render(); });
    setInterval(render, 30000);
    render();
  }

  init();
})();
