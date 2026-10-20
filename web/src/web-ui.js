// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
/* Versión web: lo que solo existe en la web (insertar el widget en otra página, avisos del navegador, enlaces). */
(function () {
  'use strict';
  const api = window.chubasco;
  const I = window.RA_I18N;
  const cfg = window.CHUBASCO_WEB || {};
  const $ = (id) => document.getElementById(id);
  const attr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Tamaño del iframe de cada widget (algo más alto que en el escritorio: lleva los créditos de los datos).
  const SIZES = { small: [170, 186], medium: [360, 184], large: [360, 414] };

  // Textos propios de la web: los datos se guardan en el navegador (no «en
  // este ordenador»), no hay ubicación aproximada y, en una pantalla táctil, no
  // hay clic derecho sino mantener pulsado. La interfaz común pone los textos
  // antes de que esto corra, así que se vuelven a poner aquí (relabel).
  const touch = matchMedia('(pointer: coarse)').matches;
  const swaps = [
    ['set.sourcesText', 'web.sourcesText'],
    ['ui.onboardText', touch ? 'web.onboardTextTouch' : 'web.onboardText'],
    ...(touch ? [['ui.rightClickHint', 'web.longPressHint']] : [])
  ].map(([from, to]) => {
    const el = document.querySelector(`[data-i18n="${from}"]`);
    if (el) el.dataset.i18n = to;
    return el;
  }).filter(Boolean);
  // Sin teclado, los atajos sobran.
  if (touch) for (const key of ['set.shortcuts', 'set.shortcutsText']) { const el = document.querySelector(`[data-i18n="${key}"]`); if (el) el.hidden = true; }
  if (cfg.releases) {
    $('web-download').href = cfg.releases;
    $('web-download').hidden = false;
  }

  let state = null;
  const t = () => I.make(I.resolveLang(state.settings.language, state.systemLocale));
  const relabel = () => { const tr = t(); for (const el of swaps) el.textContent = tr(el.dataset.i18n); };

  // ------------------------------------------------------------------
  // Insertar en otra web

  function embedUrl(loc, o) {
    const u = new URL('embed.html', location.href);
    const q = new URLSearchParams({ lat: loc.lat.toFixed(4), lon: loc.lon.toFixed(4), name: loc.name, size: o.size });
    if (o.theme !== 'auto') q.set('theme', o.theme);
    if (o.lang !== 'auto') q.set('lang', o.lang);
    if (state.settings.units.distance === 'mi') q.set('units', 'imperial');
    u.search = q.toString();
    return u.href;
  }

  function updateEmbed() {
    const loc = state.locations.find((l) => l.id === $('em-loc').value);
    if (!loc) return;
    const o = { size: $('em-size').value, theme: $('em-theme').value, lang: $('em-lang').value };
    const url = embedUrl(loc, o);
    const [w, h] = SIZES[o.size];
    const frame = $('em-frame');
    if (frame.getAttribute('src') !== url) frame.src = url;
    frame.width = w;
    frame.height = h;
    $('em-code').value = `<iframe src="${attr(url)}" width="${w}" height="${h}" style="border:0;border-radius:16px;max-width:100%" loading="lazy" title="${attr('Chubasco · ' + loc.name)}"></iframe>`;
  }

  function renderEmbed() {
    const locs = state.locations;
    $('em-need').hidden = locs.length > 0;
    $('em-body').hidden = !locs.length;
    if (!locs.length) return;
    const sel = $('em-loc');
    const keep = sel.value;
    sel.innerHTML = locs.map((l) => `<option value="${attr(l.id)}">${attr(l.name)}</option>`).join('');
    sel.value = locs.some((l) => l.id === keep) ? keep : state.activeLocationId || locs[0].id;
    updateEmbed();
  }

  $('embed-button').addEventListener('click', () => { renderEmbed(); $('embed-dialog').showModal(); });
  for (const id of ['em-loc', 'em-size', 'em-theme', 'em-lang']) $(id).addEventListener('change', updateEmbed);
  $('em-copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    try { await api.copy($('em-code').value); btn.textContent = t()('set.push.copied'); } catch (err) { $('em-code').select(); }
    setTimeout(() => { btn.textContent = label; }, 2500);
  });
  $('em-code').addEventListener('focus', (e) => e.target.select());
  // Al cerrar, el widget de muestra deja de consultar datos.
  $('embed-dialog').addEventListener('close', () => { $('em-frame').removeAttribute('src'); });

  // ------------------------------------------------------------------
  // Avisos del navegador (solo con la página abierta)

  function renderAlerts() {
    const supported = 'Notification' in window;
    const perm = supported ? Notification.permission : null;
    $('web-alerts-allow').hidden = perm !== 'default';
    $('web-alerts-state').textContent = perm === 'granted' ? t()('web.alertsOn') : perm === 'denied' ? t()('web.alertsBlocked') : '';
  }
  $('web-alerts-allow').addEventListener('click', async () => {
    await Notification.requestPermission();
    renderAlerts();
  });

  // ------------------------------------------------------------------
  // Móvil: el panel es una hoja sobre el mapa (ver styles.css). Plegada deja
  // ver el lugar y el estado; se despliega tocándola o arrastrándola.

  const narrow = matchMedia('(max-width: 760px)');
  const app = $('app');
  const sheet = $('sidebar');
  const handle = sheet.querySelector('.drag');
  // El asa solo es un botón cuando se ve (en pantallas estrechas).
  const syncHandle = () => {
    if (narrow.matches) { handle.setAttribute('role', 'button'); handle.tabIndex = 0; } else { handle.removeAttribute('role'); handle.removeAttribute('tabindex'); }
  };
  syncHandle();
  narrow.addEventListener('change', syncHandle);
  const isOpen = () => sheet.classList.contains('sheet-open');
  // Lo que asoma con la hoja plegada: el lugar y el estado, sin quitarle al mapa más de un tercio.
  const peek = () => Math.round(Math.min(236, Math.max(168, window.innerHeight * 0.32)));
  const closedY = () => sheet.offsetHeight - peek();
  function fitPeek() { app.style.setProperty('--peek', `${peek()}px`); }
  function setOpen(open) {
    sheet.classList.toggle('sheet-open', open);
    handle.setAttribute('aria-expanded', String(open));
    if (!open) for (const el of sheet.querySelectorAll('.side-scroll')) el.scrollTop = 0;
  }
  fitPeek();
  window.addEventListener('resize', fitPeek);
  // La línea de tiempo va justo encima de los créditos del mapa, que ocupan más o menos líneas.
  const credits = $('attribution');
  new ResizeObserver(() => app.style.setProperty('--attr-h', `${credits.offsetHeight}px`)).observe(credits);
  setOpen(false);
  handle.addEventListener('click', () => setOpen(!isOpen()));
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!isOpen()); }
  });
  // Tocar lo que asoma la despliega; elegir lugar también (la lista va dentro).
  const control = (el) => el.closest('button, a, input, select, textarea, label, summary, .popover');
  sheet.addEventListener('click', (e) => {
    if (narrow.matches && !isOpen() && !e.target.closest('.drag') && !control(e.target)) setOpen(true);
  });
  $('loc-button').addEventListener('click', () => { if (narrow.matches) setOpen(true); });

  // Arrastre con el dedo: plegada, desde cualquier sitio; desplegada, desde el
  // asa y la cabecera, o tirando hacia abajo con el contenido ya arriba del todo.
  let drag = null;
  sheet.addEventListener('touchstart', (e) => {
    if (!narrow.matches || e.touches.length !== 1) { drag = null; return; }
    drag = {
      y0: e.touches[0].clientY, t0: performance.now(), dy: 0, mode: null, base: 0,
      scroller: e.target.closest('.side-scroll'), fromHead: !!e.target.closest('.drag, .side-head'),
      inPopover: !!e.target.closest('.popover')
    };
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!drag || drag.inPopover) return;
    const y = e.touches[0].clientY;
    if (!drag.mode) {
      const dy = y - drag.y0;
      if (Math.abs(dy) < 6) return;
      const atTop = !drag.scroller || drag.scroller.scrollTop <= 0;
      drag.mode = !isOpen() || drag.fromHead || (dy > 0 && atTop) ? 'sheet' : 'scroll';
      if (drag.mode === 'sheet') {
        drag.base = isOpen() ? 0 : closedY();
        drag.y0 = y;
        drag.t0 = performance.now();
        sheet.classList.add('sheet-dragging');
      }
    }
    if (drag.mode !== 'sheet') return;
    e.preventDefault();
    drag.dy = y - drag.y0;
    sheet.style.transform = `translateY(${Math.max(0, Math.min(closedY(), drag.base + drag.dy))}px)`;
  }, { passive: false });
  const endDrag = (snap) => {
    const d = drag;
    drag = null;
    if (!d || d.mode !== 'sheet') return;
    sheet.classList.remove('sheet-dragging');
    sheet.style.transform = '';
    if (!snap) return;
    const v = d.dy / Math.max(1, performance.now() - d.t0); // px/ms; un gesto rápido manda
    setOpen(v < -0.35 ? true : v > 0.35 ? false : d.base + d.dy < closedY() / 2);
  };
  sheet.addEventListener('touchend', () => endDrag(true));
  sheet.addEventListener('touchcancel', () => endDrag(false));

  api.getState().then((st) => {
    state = st;
    renderAlerts();
    relabel();
    handle.setAttribute('aria-label', t()('web.sheet'));
    // Sin ningún lugar aún: la hoja abierta, con el buscador.
    if (!st.locations.length) setOpen(true);
    api.on('locations', (p) => {
      state.locations = p.locations;
      state.activeLocationId = p.activeLocationId;
      if ($('embed-dialog').open) renderEmbed();
    });
    api.on('settings', (p) => {
      state.settings = p.settings;
      renderAlerts();
      relabel();
      handle.setAttribute('aria-label', t()('web.sheet'));
      if ($('embed-dialog').open) updateEmbed();
    });
  });
})();
