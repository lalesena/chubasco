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

  // En la web los datos se guardan en el navegador, no "en este ordenador".
  const sources = document.querySelector('[data-i18n="set.sourcesText"]');
  if (sources) sources.dataset.i18n = 'web.sourcesText';
  if (cfg.releases) {
    $('web-download').href = cfg.releases;
    $('web-download').hidden = false;
  }

  let state = null;
  const t = () => I.make(I.resolveLang(state.settings.language, state.systemLocale));

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

  api.getState().then((st) => {
    state = st;
    renderAlerts();
    api.on('locations', (p) => {
      state.locations = p.locations;
      state.activeLocationId = p.activeLocationId;
      if ($('embed-dialog').open) renderEmbed();
    });
    api.on('settings', (p) => {
      state.settings = p.settings;
      renderAlerts();
      if ($('embed-dialog').open) updateEmbed();
    });
  });
})();
