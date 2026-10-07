/*
 * Widget: el estado de una ubicación de un vistazo. El mismo código sirve
 * para el widget de escritorio de la app (Mac y Windows) y para el que se
 * inserta en otras webs (versión web, con `embed` en el estado).
 */
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
  const SIZES = ['small', 'medium', 'large'];
  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  // Atribución en otras webs: OPERA pide autoría y licencia (CC BY 4.0). En
  // el tamaño pequeño, la forma corta (la web enlazada la da completa).
  const credit = () => [
    link('https://www.eumetnet.eu/', size() === 'small' ? 'OPERA' : 'EUMETNET OPERA') + ' ' + link('https://creativecommons.org/licenses/by/4.0/', 'CC BY'),
    link('https://open-meteo.com/', 'Open-Meteo'),
    link('https://www.eumetsat.int/', 'EUMETSAT')
  ].join(' · ');

  const S = { settings: null, locations: [], activeId: null, statuses: {}, systemLocale: 'es', embed: null, t: I.make('es') };

  const prefs = () => (S.settings && S.settings.widget) || {};
  const size = () => {
    const s = S.embed ? S.embed.size : prefs().size;
    return SIZES.includes(s) ? s : 'medium';
  };
  function current() {
    const id = prefs().locationId;
    return S.locations.find((l) => l.id === id) || S.locations.find((l) => l.id === S.activeId) || S.locations[0] || null;
  }

  function applyI18n() {
    const t = S.t;
    document.documentElement.lang = t.lang;
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
    if (S.embed) $('w').title = t('widget.open');
  }

  function render() {
    const t = S.t;
    const sz = size();
    const root = $('w');
    root.dataset.size = sz;
    const loc = current();
    root.classList.toggle('empty', !loc);
    if (!loc) {
      root.dataset.level = 'unknown';
      $('w-name').textContent = 'Chubasco';
      $('w-headline').textContent = t(S.embed ? 'widget.badPlace' : 'widget.empty');
      for (const id of ['w-sub', 'w-lines', 'w-chart', 'w-meta']) $(id).innerHTML = '';
      $('w-more-block').hidden = true;
      return;
    }

    const st = S.statuses[loc.id];
    const b = D.brief(st, loc, S.settings, t);
    root.dataset.level = b.level;
    $('w-name').textContent = loc.name;
    const meter = $('w-meter');
    meter.style.background = b.dbz !== null && b.dbz !== undefined ? P.cssFor(b.dbz, b.kind) : b.level === 'clear' ? '#5fb38a' : '';
    meter.style.width = b.level === 'raining' ? '64px' : b.level === 'imminent' ? '52px' : b.level === 'approaching' ? '44px' : '32px';
    $('w-headline').textContent = b.headline;
    $('w-sub').textContent = (sz === 'small' ? b.subShort : b.sub) || '';

    // Líneas extra: mediano, la más importante; grande, todas.
    const lines = [];
    if (b.severe) lines.push(`<p class="severe-line">${WARN_ICON}${esc(b.severe)}</p>`);
    if (b.lightning) lines.push(`<p class="lightning-line">${BOLT_ICON}${esc(b.lightning)}</p>`);
    if (b.outlook && b.outlook !== b.sub) lines.push(`<p class="outlook">${esc(b.outlook)}</p>`);
    $('w-lines').innerHTML = sz === 'small' ? '' : sz === 'medium' ? lines.slice(0, 1).join('') : lines.join('');

    const chart = $('w-chart');
    C.chartCompact(chart, { status: st, loc, t, width: chart.clientWidth, height: chart.clientHeight, labels: true });

    // Grande: las demás ubicaciones (escritorio) o las próximas 24 h.
    const more = $('w-more-block');
    more.hidden = sz !== 'large';
    if (sz === 'large') {
      const others = S.embed ? [] : S.locations.filter((l) => l.id !== loc.id).slice(0, 3);
      $('w-others').hidden = !others.length;
      $('w-24h').hidden = !!others.length;
      $('w-more-title').textContent = t(others.length ? 'ui.locations' : 'ui.next24h');
      if (others.length) {
        $('w-others').innerHTML = '';
        for (const l of others) {
          const od = D.describe(S.statuses[l.id], l, S.settings, t);
          const li = document.createElement('li');
          li.innerHTML = `<button type="button"><span class="dot" data-level="${esc(od.level)}"></span><span class="l-name">${esc(l.name)}</span><span class="l-head">${esc(od.headline)}</span></button>`;
          li.firstChild.addEventListener('click', () => show(l.id));
          $('w-others').appendChild(li);
        }
      } else {
        C.chart24h($('w-24h'), { status: st, settings: S.settings, t });
      }
    }

    const r = st && st.radar;
    $('w-meta').textContent = r && r.ok ? D.fmtClock(t, r.frameTime * 1000) : '';
    $('w-meta').title = r && r.ok ? t('mini.radar', { time: $('w-meta').textContent }) : '';
  }

  /** Otra ubicación en el widget: si sigue a la de la app, cambia la de la app. */
  function show(id) {
    if (prefs().locationId) api.updateSettings({ widget: { locationId: id } });
    else api.setActive(id);
  }

  // Escritorio: se arrastra desde cualquier punto; un clic sin mover abre la app.
  function wireDesktop() {
    const root = $('w');
    let drag = null;
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a')) return;
      drag = { x: e.screenX, y: e.screenY, moved: false };
      root.setPointerCapture(e.pointerId);
      api.widgetDrag('start');
    });
    root.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 4) return;
      drag.moved = true;
      api.widgetDrag('move');
    });
    const end = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      api.widgetDrag('end');
      const loc = current();
      if (!moved && e.type === 'pointerup') api.showMain(loc && loc.id);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('lostpointercapture', end);
    root.addEventListener('contextmenu', (e) => { e.preventDefault(); api.widgetMenu(); });
    $('w-more').addEventListener('click', () => api.widgetMenu());
  }

  // En otra web: el widget entero es un enlace a la versión web con esta ubicación.
  function wireEmbed() {
    const root = $('w');
    $('w-more').remove();
    $('w-credit').innerHTML = credit();
    root.tabIndex = 0;
    root.setAttribute('role', 'link');
    const open = () => window.open(S.embed.appUrl, '_blank', 'noopener');
    root.addEventListener('click', (e) => { if (!e.target.closest('a')) open(); });
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  }

  async function init() {
    const st = await api.getState();
    Object.assign(S, {
      settings: st.settings, locations: st.locations, activeId: st.activeLocationId,
      statuses: st.statuses || {}, systemLocale: st.systemLocale, embed: st.embed || null
    });
    document.body.classList.add('platform-' + st.platform);
    document.body.classList.toggle('embed', !!S.embed);
    S.t = I.make(I.resolveLang(S.settings.language, S.systemLocale));
    applyI18n();
    if (S.embed) wireEmbed(); else wireDesktop();

    api.on('status', (p) => { S.statuses = p.statuses || {}; render(); });
    api.on('locations', (p) => { S.locations = p.locations; S.activeId = p.activeLocationId; render(); });
    api.on('settings', (p) => {
      const lang = p.settings.language !== S.settings.language;
      S.settings = p.settings;
      if (lang) { S.t = I.make(I.resolveLang(S.settings.language, S.systemLocale)); applyI18n(); }
      render();
    });
    new ResizeObserver(() => render()).observe(document.body);
    setInterval(render, 30000);
    render();
  }

  init();
})();
