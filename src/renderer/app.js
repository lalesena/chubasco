/* Controlador de la interfaz. */
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

  const S = {
    settings: null, locations: [], commutes: [], activeId: null, statuses: {}, frames: null,
    history: [], error: null, systemLocale: 'es', platform: 'darwin', quietUntil: 0,
    t: I.make('es'), running: false
  };

  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  let mapApi = null;
  let aguaApi = null;

  // ------------------------------------------------------------------
  // Utilidades

  function active() { return S.locations.find((l) => l.id === S.activeId) || null; }
  function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

  function applyI18n() {
    const t = S.t;
    document.documentElement.lang = t.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
  }

  function setLang() {
    S.t = I.make(I.resolveLang(S.settings.language, S.systemLocale));
    applyI18n();
    if (mapApi) { mapApi.setT(S.t); mapApi.renderLegend(S.settings); }
    if (aguaApi) aguaApi.refresh();
  }

  function baseKey() {
    const b = S.settings.baseMap;
    if (b && b !== 'auto') return b;
    // En la web el tema elegido no cambia el del sistema: se mira también el ajuste.
    const theme = S.settings.theme;
    return theme === 'dark' || (theme !== 'light' && darkMQ.matches) ? 'dark' : 'light';
  }

  // ------------------------------------------------------------------
  // Render del panel

  function renderHeader() {
    const loc = active();
    $('loc-name').textContent = loc ? loc.name : S.t('ui.addLocation');
    $('onboarding').hidden = !!loc;
    for (const id of ['status', 'chart2h-block', 'chart24h-block', 'alarm-block', 'accuracy-block']) $(id).hidden = !loc;
    $('history-block').hidden = !S.history.length && !loc;
  }

  function renderStatus() {
    const loc = active();
    if (!loc) return;
    const t = S.t;
    const st = S.statuses[loc.id];
    const d = D.describe(st, loc, S.settings, t);
    const statusEl = $('status');
    statusEl.dataset.level = d.level;
    $('headline').textContent = d.headline;
    $('detail').textContent = d.detail || '';
    $('outlook').textContent = d.outlook || '';
    $('lightning-line').innerHTML = d.lightning ? BOLT_ICON + esc(d.lightning) : '';
    $('severe-line').innerHTML = d.severe ? WARN_ICON + esc(d.severe) : '';
    // "Avísame cuando pare": visible mientras llueve (o si ya está activo).
    const watching = !!loc.dryWatch;
    $('dry-watch').hidden = !watching && d.level !== 'raining';
    $('dry-watch-off').hidden = watching;
    $('dry-watch-active').hidden = !watching;
    if (watching) $('dry-watch-text').textContent = t('ui.dryWatch.active', { n: loc.dryWatch.minMin });
    const meter = $('status-meter');
    meter.style.background = d.dbz !== null && d.dbz !== undefined ? P.cssFor(d.dbz, d.kind) : d.level === 'clear' ? '#5fb38a' : '';
    meter.style.width = d.level === 'raining' ? '120px' : d.level === 'imminent' ? '96px' : d.level === 'approaching' ? '80px' : '56px';

    const r = st && st.radar;
    const parts = [];
    if (r && r.ok) parts.push(t('ui.radarAge', { time: D.fmtClock(t, r.frameTime * 1000) }));
    if (r && r.checkedAt) parts.push(t('ui.checked', { ago: D.fmtAgo(t, r.checkedAt) }));
    $('radar-meta').textContent = parts.join(' · ');
    $('refresh-button').classList.toggle('spinning', !!S.running);

    // Gráficas
    const info = C.chart2h($('chart2h'), { status: st, settings: S.settings, t, loc });
    $('chart2h-note').textContent = info.hasRadar && !info.hasMotion ? t('ui.nowcastUnavailable') : '';
    C.chart24h($('chart24h'), { status: st, settings: S.settings, t });
    const m = st && st.model && st.model.ok ? st.model : null;
    $('current-weather').textContent = m && m.current && m.current.temp !== undefined
      ? t('ui.currentWeather', { temp: D.fmtTemp(t, m.current.temp, S.settings.units), wind: D.fmtSpeed(t, m.current.wind || 0, S.settings.units) })
      : '';

    // Mapa: movimiento para la previsión extrapolada y marcadores
    if (mapApi) {
      mapApi.setMotion(r && r.ok ? r.motion : null);
      mapApi.setLocations(S.locations, S.activeId, S.statuses);
    }
    if ($('accuracy-block').open) renderAccuracy(false);
  }

  // ------------------------------------------------------------------
  // Precisión (autoverificación)

  let accSeq = 0, accLast = 0;
  async function renderAccuracy(force) {
    const loc = active();
    if (!loc || (!force && Date.now() - accLast < 20000)) return;
    accLast = Date.now();
    const my = ++accSeq;
    let res;
    try { res = await api.verifyStats(loc.id); } catch (e) { return; }
    if (my !== accSeq || !res || !res.loc) return;
    const t = S.t;
    const v = res.loc;
    const pct = (x) => (x === null || x === undefined ? t('ui.acc.none') : Math.round(x * 100) + ' %');
    const pts = (x) => (x === null || x === undefined ? t('ui.acc.none') : (x >= 0 ? '+' : '−') + Math.abs(Math.round(x * 100)));
    const leads = [10, 30, 60];
    const events = v.leads[30].events;
    let html = `<p class="hint">${esc(t('ui.acc.scope'))}</p>`;
    if (events < 3) {
      html += `<p class="acc-note">${esc(t('ui.acc.collecting', { n: v.frames }))}</p>`;
      $('accuracy-summary').textContent = '';
    } else {
      html += '<table class="acc-table"><thead><tr><th></th>' + leads.map((n) => `<th>${esc(t('ui.acc.lead', { n }))}</th>`).join('') + '</tr></thead><tbody>';
      html += `<tr><th>${esc(t('ui.acc.pod'))}</th>` + leads.map((n) => `<td>${pct(v.leads[n].pod)}</td>`).join('') + '</tr>';
      html += `<tr><th>${esc(t('ui.acc.far'))}</th>` + leads.map((n) => `<td>${pct(v.leads[n].far)}</td>`).join('') + '</tr>';
      html += `<tr><th>${esc(t('ui.acc.skill'))}</th>` + leads.map((n) => `<td>${pts(v.leads[n].skill)}</td>`).join('') + '</tr>';
      html += '</tbody></table>';
      $('accuracy-summary').textContent = `${pct(v.leads[30].pod)} · ${t('ui.acc.lead', { n: 30 })}`;
    }
    if (v.eta) {
      html += `<p class="acc-note">${esc(t('ui.acc.eta', { mae: Math.round(v.eta.mae), bias: (v.eta.bias >= 0 ? '+' : '−') + Math.abs(Math.round(v.eta.bias)), n: v.eta.n }))}</p>`;
    }
    const ep = v.episodes;
    if (ep.hit + ep.missed + ep.fa > 0) {
      html += `<p class="acc-note">${esc(t('ui.acc.episodes', { hit: ep.hit, missed: ep.missed, fa: ep.fa, lead: ep.lead === null ? '–' : Math.round(ep.lead) }))}</p>`;
    }
    const cal = v.calibration && v.calibration.leads && v.calibration.leads[30];
    if (cal) {
      html += `<p class="acc-note">${esc(cal.active
        ? t('ui.acc.calOn', { real: Math.round(cal.at70 * 100), w: cal.wActive ? Math.round(cal.w * 100) : '—' })
        : t('ui.acc.calOff', { n: cal.n, need: v.calibration.minN, ev: cal.events, needEv: v.calibration.minEvents }))}</p>`;
    }
    const r = S.statuses[loc.id] && S.statuses[loc.id].radar;
    if (r && r.ok && r.filtered && (r.filtered.clutterPx || r.filtered.speckles)) {
      html += `<p class="hint">${esc(t('ui.acc.filtered', { clutter: r.filtered.clutterPx, speckles: r.filtered.speckles }))}</p>`;
    }
    $('accuracy').innerHTML = html;
  }

  function renderAlarm() {
    const loc = active();
    if (!loc) return;
    const a = loc.alarm;
    const t = S.t;
    $('alarm-block').classList.toggle('disabled', !a.enabled);
    $('al-enabled').checked = !!a.enabled;
    $('al-radius').value = a.radiusKm;
    $('al-radius-out').textContent = D.fmtDist(t, a.radiusKm, S.settings.units);
    $('al-level').value = a.level;
    for (const k of ['inRadius', 'imminent', 'atLocation', 'ended', 'model', 'lightning', 'severe']) $('al-' + k).checked = !!a[k];
    $('al-imminentMin').value = String(a.imminentMin || 30);
    $('al-minProb').value = String(a.minProb || 0.5);
    $('al-lightningKm').value = String(a.lightningKm || 20);
    $('alarm-summary').textContent = a.enabled ? `${D.fmtDist(t, a.radiusKm, S.settings.units)} · ${t('ui.level.' + a.level).split(' (')[0]}` : '—';
    $('remove-loc').classList.remove('confirm');
    $('remove-loc').textContent = t('ui.remove');
  }

  function renderHistory() {
    const t = S.t;
    const ol = $('history');
    if (!S.history.length) {
      ol.innerHTML = `<li class="empty">${esc(t('ui.historyEmpty'))}</li>`;
      $('clear-history').hidden = true;
      return;
    }
    $('clear-history').hidden = false;
    ol.innerHTML = S.history.slice(0, 20).map((h) => {
      const when = new Intl.DateTimeFormat(t.lang === 'es' ? 'es-ES' : 'en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(h.ts));
      const silenced = h.silenced ? ` · ${h.silenced === 'quiet' ? t('set.quiet').toLowerCase() : t('tray.snooze').toLowerCase()}` : '';
      return `<li><div class="h-title">${esc(h.title)}</div><div class="h-body">${esc(h.body)}</div><div class="h-meta">${esc(when)}${esc(silenced)}</div></li>`;
    }).join('');
  }

  function renderBanner() {
    const t = S.t;
    const b = $('banner');
    const action = $('banner-action');
    if (S.settings.snoozeUntil > Date.now()) {
      b.hidden = false;
      $('banner-text').textContent = t('ui.snoozed', { time: D.fmtClock(t, S.settings.snoozeUntil) });
      action.hidden = false;
      action.textContent = t('ui.resume');
      action.onclick = () => api.snooze(0);
    } else if (S.quietUntil) {
      b.hidden = false;
      $('banner-text').textContent = t('ui.quietNow', { time: D.fmtClock(t, S.quietUntil) });
      action.hidden = true;
    } else if (!S.frames && S.error) {
      b.hidden = false;
      $('banner-text').textContent = t('ui.offline');
      action.hidden = true;
    } else {
      b.hidden = true;
    }
  }

  function renderLocList() {
    const t = S.t;
    const ul = $('loc-list');
    ul.innerHTML = '';
    for (const loc of S.locations) {
      const d = D.describe(S.statuses[loc.id], loc, S.settings, t);
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" aria-current="${loc.id === S.activeId}"><span class="dot" data-level="${esc(d.level)}"></span><span class="l-name">${esc(loc.name)}</span><span class="l-head">${esc(d.headline)}</span></button>`;
      li.firstChild.addEventListener('click', () => { selectLocation(loc.id, true); closePopover(); });
      ul.appendChild(li);
    }
  }

  function renderAll() {
    renderHeader();
    renderStatus();
    renderAlarm();
    renderHistory();
    renderBanner();
    if (!$('loc-popover').hidden) renderLocList();
  }

  // ------------------------------------------------------------------
  // Ubicaciones

  async function selectLocation(id, focus) {
    S.activeId = id;
    await api.setActive(id);
    const loc = active();
    if (loc && focus && mapApi) mapApi.focus(loc.lat, loc.lon, 8);
    renderAll();
    if ($('accuracy-block').open) renderAccuracy(true);
  }

  async function addLocation(place) {
    try {
      const loc = await api.addLocation(place);
      // El proceso principal ya ha difundido la lista; evitamos duplicados.
      if (!S.locations.some((l) => l.id === loc.id)) S.locations.push(loc);
      S.activeId = loc.id;
      if (mapApi) mapApi.focus(loc.lat, loc.lon, 8);
      closePopover();
      renderAll();
    } catch (e) {
      console.error(e);
    }
  }

  function wireSearch(input, list) {
    let seq = 0;
    const run = debounce(async () => {
      const q = input.value.trim();
      const my = ++seq;
      if (q.length < 2) { list.innerHTML = ''; return; }
      list.innerHTML = `<li class="msg">${esc(S.t('ui.searching'))}</li>`;
      let res = [];
      try { res = await api.search(q); } catch (e) { res = []; }
      if (my !== seq) return;
      if (!res.length) { list.innerHTML = `<li class="msg">${esc(S.t('ui.noResults', { q }))}</li>`; return; }
      list.innerHTML = '';
      for (const r of res) {
        const li = document.createElement('li');
        li.innerHTML = `<button type="button">${esc(r.name)}<span class="r-detail">${esc(r.detail)}</span></button>`;
        li.firstChild.addEventListener('click', () => { input.value = ''; list.innerHTML = ''; addLocation({ name: r.name, lat: r.lat, lon: r.lon }); });
        list.appendChild(li);
      }
    }, 280);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const b = list.querySelector('button'); if (b) b.click(); }
      if (e.key === 'ArrowDown') { const b = list.querySelector('button'); if (b) { e.preventDefault(); b.focus(); } }
    });
  }

  async function useIp(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = S.t('ui.searching');
    try {
      const p = await api.ipLocation();
      await addLocation({ name: p.name || S.t('ui.myLocation'), lat: p.lat, lon: p.lon });
    } catch (e) {
      btn.textContent = S.t('ui.ipFailed');
      setTimeout(() => { btn.textContent = label; }, 3500);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    btn.textContent = label;
  }

  // "Aquí": posición del sistema (Core Location / Windows) o, si no hay, por IP.
  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('sin geolocalización')); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, source: 'system' }),
        reject,
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60000 }
      );
    });
  }

  async function locateHere() {
    let pos;
    try {
      pos = await getPosition();
    } catch (e) {
      const ip = await api.ipLocation();
      pos = { lat: ip.lat, lon: ip.lon, source: 'ip' };
    }
    return api.follow(pos);
  }

  async function followHere(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = S.t('ui.locating');
    try {
      const loc = await locateHere();
      S.activeId = loc.id;
      if (mapApi) mapApi.focus(loc.lat, loc.lon, 8);
      closePopover();
      renderAll();
      btn.textContent = label;
    } catch (e) {
      btn.textContent = S.t('ui.ipFailed');
      setTimeout(() => { btn.textContent = label; }, 3500);
    }
    btn.disabled = false;
  }

  function openPopover() {
    renderLocList();
    $('loc-popover').hidden = false;
    $('loc-button').setAttribute('aria-expanded', 'true');
    setTimeout(() => $('search-input').focus(), 0);
  }
  function closePopover() {
    $('loc-popover').hidden = true;
    $('loc-button').setAttribute('aria-expanded', 'false');
  }

  // ------------------------------------------------------------------
  // Menú contextual del mapa

  function showContextMenu(latlng, point) {
    const t = S.t;
    const menu = $('ctx-menu');
    const loc = active();
    const items = [[t('ui.ctxAdd'), () => addLocation({ lat: latlng.lat, lon: latlng.lng })]];
    if (loc) items.push([t('ui.ctxMove', { name: loc.name }), async () => {
      const upd = await api.updateLocation(loc.id, { lat: latlng.lat, lon: latlng.lng });
      if (upd) Object.assign(loc, upd);
      delete S.statuses[loc.id];
      renderAll();
    }]);
    items.push([t('ui.ctxCenter'), () => mapApi.map.panTo(latlng)]);
    menu.innerHTML = '';
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => { menu.hidden = true; fn(); });
      menu.appendChild(b);
    }
    const wrap = $('map-wrap').getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = Math.min(point.x, wrap.width - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.min(point.y, wrap.height - menu.offsetHeight - 8) + 'px';
    menu.firstChild.focus();
  }

  // ------------------------------------------------------------------
  // Ajustes

  // ------------------------------------------------------------------
  // Trayectos (en Ajustes)

  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // lunes primero

  function renderCommutes() {
    const t = S.t;
    const names = new Map(S.locations.map((l) => [l.id, l.name]));
    const short = t.raw('days.short');
    const ul = $('commute-list');
    ul.innerHTML = '';
    for (const c of S.commutes) {
      const li = document.createElement('li');
      const days = DAY_ORDER.filter((d) => c.days.includes(d)).map((d) => short[d]).join(' ');
      li.innerHTML = `<label class="cm-on"><input type="checkbox" ${c.enabled ? 'checked' : ''}></label>` +
        `<span class="cm-desc"><strong>${esc(names.get(c.fromId) || '?')} → ${esc(names.get(c.toId) || '?')}</strong>` +
        `<small>${esc(c.time)} · ${esc(days)} · ${esc(D.fmtDuration(t, c.durationMin))}</small><small class="cm-result"></small></span>` +
        `<button type="button" class="link-btn small cm-check">${esc(t('set.cm.check'))}</button>` +
        `<button type="button" class="link-btn small cm-remove">${esc(t('set.cm.remove'))}</button>`;
      li.querySelector('input').addEventListener('change', (e) => api.updateCommute(c.id, { enabled: e.target.checked }));
      li.querySelector('.cm-remove').addEventListener('click', () => api.removeCommute(c.id));
      li.querySelector('.cm-check').addEventListener('click', async (e) => {
        const btn = e.currentTarget, out = li.querySelector('.cm-result');
        btn.disabled = true;
        out.textContent = t('set.cm.checking');
        try {
          const r = await api.checkCommute(c.id);
          out.textContent = r ? `${r.title}. ${r.body}` : t('set.cm.noData');
        } catch (err) { out.textContent = t('set.cm.noData'); }
        btn.disabled = false;
      });
      ul.appendChild(li);
    }
    const enough = S.locations.length >= 2;
    $('commute-form').hidden = !enough;
    $('commute-need').hidden = enough;
    const opts = S.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
    for (const id of ['cm-from', 'cm-to']) { const v = $(id).value; $(id).innerHTML = opts; if (v && names.has(v)) $(id).value = v; }
    if ($('cm-from').value === $('cm-to').value && S.locations[1]) $('cm-to').value = S.locations[1].id;
    if (!$('cm-days').childElementCount) {
      $('cm-days').innerHTML = DAY_ORDER.map((d) => `<label><input type="checkbox" value="${d}" ${d >= 1 && d <= 5 ? 'checked' : ''}><span>${esc(short[d])}</span></label>`).join('');
    } else {
      $('cm-days').querySelectorAll('span').forEach((sp, i) => { sp.textContent = short[DAY_ORDER[i]]; });
    }
  }

  function fillSettings() {
    renderCommutes();
    const s = S.settings;
    $('set-language').value = s.language;
    $('set-theme').value = s.theme;
    $('set-rate').value = s.units.rate;
    $('set-dist').value = s.units.distance;
    $('set-interval').value = String(s.checkIntervalMin);
    $('set-quiet').checked = !!s.quietHours.enabled;
    $('set-quiet-start').value = s.quietHours.start;
    $('set-quiet-end').value = s.quietHours.end;
    $('set-sound').checked = !!s.sound;
    $('set-login').checked = !!s.launchAtLogin;
    $('set-hidden').checked = !!s.startHidden;
    $('set-tray').checked = !!s.closeToTray;
    $('set-push').checked = !!(s.push && s.push.enabled);
    $('push-details').hidden = !(s.push && s.push.enabled);
    $('push-topic').value = (s.push && s.push.topic) || '';
    $('set-summary').checked = !!(s.dailySummary && s.dailySummary.enabled);
    $('set-summary-time').value = (s.dailySummary && s.dailySummary.time) || '07:30';
    const wg = s.widget || {};
    $('set-widget').checked = !!wg.enabled;
    $('set-widget-size').value = wg.size || 'medium';
    $('set-widget-top').checked = !!wg.onTop;
  }

  async function updateSettings(patch) {
    S.settings = await api.updateSettings(patch);
    setLang();
    renderAll();
    syncMapOptions();
  }

  function wireSettings() {
    const dlg = $('settings-dialog');
    $('settings-button').addEventListener('click', () => { fillSettings(); dlg.showModal(); });
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on('set-language', 'change', (e) => updateSettings({ language: e.target.value }));
    on('set-theme', 'change', (e) => updateSettings({ theme: e.target.value }));
    on('set-rate', 'change', (e) => updateSettings({ units: { rate: e.target.value } }));
    on('set-dist', 'change', (e) => updateSettings({ units: { distance: e.target.value } }));
    on('set-interval', 'change', (e) => updateSettings({ checkIntervalMin: Number(e.target.value) }));
    const quiet = () => updateSettings({ quietHours: { enabled: $('set-quiet').checked, start: $('set-quiet-start').value || '23:00', end: $('set-quiet-end').value || '07:00' } });
    on('set-quiet', 'change', quiet);
    on('set-quiet-start', 'change', quiet);
    on('set-quiet-end', 'change', quiet);
    on('set-sound', 'change', (e) => updateSettings({ sound: e.target.checked }));
    on('set-login', 'change', (e) => updateSettings({ launchAtLogin: e.target.checked }));
    on('set-hidden', 'change', (e) => updateSettings({ startHidden: e.target.checked }));
    on('set-tray', 'change', (e) => updateSettings({ closeToTray: e.target.checked }));
    const summary = () => updateSettings({ dailySummary: { enabled: $('set-summary').checked, time: $('set-summary-time').value || '07:30' }, lastSummaryDay: null });
    on('set-summary', 'change', summary);
    const widget = () => updateSettings({ widget: { enabled: $('set-widget').checked, size: $('set-widget-size').value, onTop: $('set-widget-top').checked } });
    for (const id of ['set-widget', 'set-widget-size', 'set-widget-top']) on(id, 'change', widget);
    on('cm-add', 'click', async () => {
      const days = [...$('cm-days').querySelectorAll('input:checked')].map((i) => Number(i.value));
      try {
        await api.addCommute({ fromId: $('cm-from').value, toId: $('cm-to').value, time: $('cm-time').value, days, durationMin: Number($('cm-dur').value) });
      } catch (e) { console.warn(e); }
    });
    on('set-push', 'change', async (e) => { await updateSettings({ push: { enabled: e.target.checked } }); fillSettings(); });
    const flash = (btn, key) => { const label = btn.textContent; btn.textContent = S.t(key); setTimeout(() => { btn.textContent = label; }, 2500); };
    on('push-copy', 'click', (e) => { api.copy($('push-topic').value); flash(e.currentTarget, 'set.push.copied'); });
    on('push-test', 'click', async (e) => {
      const btn = e.currentTarget;
      try { await api.pushTest(); flash(btn, 'set.push.sent'); } catch (err) { flash(btn, 'set.push.failed'); }
    });
    on('set-summary-time', 'change', summary);
  }

  // ------------------------------------------------------------------
  // Alarma

  function wireAlarm() {
    const patch = (p) => {
      const loc = active();
      if (!loc) return;
      loc.alarm = { ...loc.alarm, ...p };
      renderAlarm();
      renderStatus();
      saveAlarm(loc.id, p);
    };
    const pending = {};
    const timers = {};
    const saveAlarm = (id, p) => {
      pending[id] = { ...(pending[id] || {}), ...p };
      clearTimeout(timers[id]);
      timers[id] = setTimeout(() => { const q = pending[id]; delete pending[id]; api.updateLocation(id, { alarm: q }); }, 350);
    };

    $('al-enabled').addEventListener('change', (e) => patch({ enabled: e.target.checked }));
    $('al-radius').addEventListener('input', (e) => patch({ radiusKm: Number(e.target.value) }));
    $('al-level').addEventListener('change', (e) => patch({ level: e.target.value }));
    for (const k of ['inRadius', 'imminent', 'atLocation', 'ended', 'model', 'lightning', 'severe']) {
      $('al-' + k).addEventListener('change', (e) => patch({ [k]: e.target.checked }));
    }
    $('al-imminentMin').addEventListener('change', (e) => patch({ imminentMin: Number(e.target.value) }));
    $('al-minProb').addEventListener('change', (e) => patch({ minProb: Number(e.target.value) }));
    $('al-lightningKm').addEventListener('change', (e) => patch({ lightningKm: Number(e.target.value) }));
    $('test-alert').addEventListener('click', () => api.testAlert(S.activeId));

    $('rename-loc').addEventListener('click', () => {
      const loc = active();
      if (!loc) return;
      const nameEl = $('loc-name');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = loc.name;
      input.setAttribute('aria-label', S.t('ui.renamePrompt'));
      input.className = 'rename-input';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const done = async (save) => {
        input.replaceWith(nameEl);
        if (save && input.value.trim() && input.value.trim() !== loc.name) {
          loc.name = input.value.trim();
          loc.customName = true;
          await api.updateLocation(loc.id, { name: loc.name, customName: true });
        }
        renderAll();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true), { once: true });
    });

    $('remove-loc').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const loc = active();
      if (!loc) return;
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = S.t('ui.confirmRemove', { name: loc.name });
        setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = S.t('ui.remove'); }, 4000);
        return;
      }
      await api.removeLocation(loc.id);
      S.locations = S.locations.filter((l) => l.id !== loc.id);
      delete S.statuses[loc.id];
      S.activeId = S.locations[0] ? S.locations[0].id : null;
      renderAll();
    });
  }

  // ------------------------------------------------------------------
  // Mapa

  function syncMapOptions() {
    if (!mapApi) return;
    const s = S.settings;
    mapApi.setBase(baseKey());
    mapApi.setRadarOptions({ opacity: s.radarOpacity, smooth: s.smooth, coverage: s.showCoverage, future: s.showFuture });
    mapApi.renderLegend(s);
    document.querySelectorAll('input[name=base]').forEach((r) => { r.checked = r.value === (s.baseMap || 'auto'); });
    $('opacity').value = s.radarOpacity;
    $('opacity-out').textContent = Math.round(s.radarOpacity * 100) + ' %';
    $('opt-smooth').checked = !!s.smooth;
    $('opt-future').checked = !!s.showFuture;
    $('opt-coverage').checked = !!s.showCoverage;
    $('opt-lightning').checked = !!s.showLightning;
    mapApi.setLightning({ enabled: !!s.showLightning });
  }

  // Con la ventana oculta (en la bandeja) no se descargan fotogramas del mapa:
  // así no se gasta el cupo de peticiones que necesita la vigilancia.
  let framesApplied = null;
  function applyFrames() {
    if (!mapApi || !S.frames || document.hidden || framesApplied === S.frames) return;
    framesApplied = S.frames;
    mapApi.setFrames(S.frames);
  }

  function initMap() {
    mapApi = window.RA_MAP.createMap($('map'), {
      attribution: $('attribution'), track: $('tl-track'), time: $('tl-time'), rel: $('tl-rel'),
      loading: $('tl-loading'), legend: $('legend'), timeline: $('timeline'), play: $('tl-play')
    }, {
      onMarkerClick: (id) => selectLocation(id, false),
      onContextMenu: (latlng, point) => showContextMenu(latlng, point),
      onViewChange: debounce((view) => api.updateSettings({ mapView: view }).then((s) => { S.settings = s; }), 1500),
      lightningView: (q) => api.lightningView(q),
      radarTile: (q) => api.radarTile(q),
      units: () => S.settings.units
    });
    mapApi.setT(S.t);
    const loc = active();
    if (loc) mapApi.setView([loc.lat, loc.lon], 8);
    else if (S.settings.mapView) mapApi.setView(S.settings.mapView.center, S.settings.mapView.zoom);
    else if (S.t.lang === 'es') mapApi.setView([40.2, -3.7], 6);
    else mapApi.setView([48, 8], 5);
    syncMapOptions();
    applyFrames();
    document.addEventListener('visibilitychange', applyFrames);

    $('tl-play').addEventListener('click', () => mapApi.toggle());
    $('tl-prev').addEventListener('click', () => { mapApi.pause(); mapApi.step(-1); });
    $('tl-next').addEventListener('click', () => { mapApi.pause(); mapApi.step(1); });

    const layersBtn = $('layers-button');
    layersBtn.addEventListener('click', () => {
      const p = $('layers-panel');
      p.hidden = !p.hidden;
      layersBtn.setAttribute('aria-expanded', String(!p.hidden));
    });
    document.querySelectorAll('input[name=base]').forEach((r) => r.addEventListener('change', () => updateSettings({ baseMap: r.value })));
    $('opacity').addEventListener('input', (e) => {
      S.settings.radarOpacity = Number(e.target.value);
      $('opacity-out').textContent = Math.round(S.settings.radarOpacity * 100) + ' %';
      mapApi.setRadarOptions({ opacity: S.settings.radarOpacity });
    });
    $('opacity').addEventListener('change', (e) => updateSettings({ radarOpacity: Number(e.target.value) }));
    $('opt-smooth').addEventListener('change', (e) => updateSettings({ smooth: e.target.checked }));
    $('opt-future').addEventListener('change', (e) => updateSettings({ showFuture: e.target.checked }));
    $('opt-coverage').addEventListener('change', (e) => updateSettings({ showCoverage: e.target.checked }));
    $('opt-lightning').addEventListener('change', (e) => updateSettings({ showLightning: e.target.checked }));

    // Agua en España: el panel lateral y el mapa pasan a las cuencas.
    aguaApi = window.RA_AGUA.create({
      map: mapApi.map, api,
      dom: { panel: $('agua-panel'), legend: $('agua-legend') },
      getT: () => S.t, getUnits: () => S.settings.units,
      setAttribution: (html) => mapApi.setExtraAttribution(html)
    });
    $('agua-button').addEventListener('click', () => setAgua(!aguaApi.isOpen()));
    $('agua-back').addEventListener('click', () => setAgua(false));
  }

  function setAgua(on) {
    if (on) aguaApi.open(); else aguaApi.close();
    $('app').classList.toggle('agua-mode', on);
    $('side-scroll').hidden = on;
    $('agua-panel').hidden = !on;
    $('agua-title').hidden = !on;
    $('loc-button').hidden = on;
    $('agua-legend').hidden = !on;
    $('agua-button').setAttribute('aria-pressed', String(on));
    if (on) $('agua-panel').scrollTop = 0;
  }

  // ------------------------------------------------------------------
  // Teclado y clics fuera

  function wireGlobal() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); fillSettings(); $('settings-dialog').showModal(); return; }
      if (e.key === 'Escape') { closePopover(); $('ctx-menu').hidden = true; $('layers-panel').hidden = true; }
      if (typing || !mapApi) return;
      if (e.key === ' ') { e.preventDefault(); mapApi.toggle(); }
      else if (e.key === 'ArrowLeft' && !e.target.closest('#map')) { mapApi.pause(); mapApi.step(-1); }
      else if (e.key === 'ArrowRight' && !e.target.closest('#map')) { mapApi.pause(); mapApi.step(1); }
      else if (e.key === 'End') { mapApi.pause(); mapApi.goLatest(); }
    });
    // Soltar archivos sobre la ventana no debe navegar fuera de la app.
    for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault());
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#ctx-menu')) $('ctx-menu').hidden = true;
      if (!e.target.closest('#loc-popover') && !e.target.closest('#loc-button')) closePopover();
      if (!e.target.closest('.map-tools')) $('layers-panel').hidden = true;
    });
    $('loc-button').addEventListener('click', () => ($('loc-popover').hidden ? openPopover() : closePopover()));
    $('refresh-button').addEventListener('click', () => { S.running = true; renderStatus(); api.checkNow(); });
    $('clear-history').addEventListener('click', () => api.clearHistory());
    wireSearch($('search-input'), $('search-results'));
    wireSearch($('onboard-search'), $('onboard-results'));
    $('ip-button').addEventListener('click', (e) => useIp(e.currentTarget));
    $('onboard-ip').addEventListener('click', (e) => useIp(e.currentTarget));
    $('here-button').addEventListener('click', (e) => followHere(e.currentTarget));
    $('dry-watch-on').addEventListener('click', () => { if (S.activeId) api.dryWatch(S.activeId, Number($('dry-watch-min').value)); });
    $('dry-watch-cancel').addEventListener('click', () => { if (S.activeId) api.dryWatch(S.activeId, null); });
    $('onboard-here').addEventListener('click', (e) => followHere(e.currentTarget));
    $('accuracy-block').addEventListener('toggle', () => { if ($('accuracy-block').open) renderAccuracy(true); });
    darkMQ.addEventListener('change', () => syncMapOptions());
    // Refresca textos relativos ("hace 3 min").
    setInterval(() => { renderStatus(); renderBanner(); }, 30000);
  }

  // ------------------------------------------------------------------
  // Eventos del proceso principal

  function wireEvents() {
    api.on('status', (p) => {
      S.statuses = p.statuses || {};
      S.error = p.error;
      S.running = p.running;
      if (p.frames && (!S.frames || S.frames.frames.length !== p.frames.frames.length ||
        S.frames.frames[S.frames.frames.length - 1].path !== p.frames.frames[p.frames.frames.length - 1].path)) {
        S.frames = p.frames;
        applyFrames();
      }
      renderStatus();
      renderBanner();
      if (!$('loc-popover').hidden) renderLocList();
    });
    api.on('locations', (p) => {
      S.locations = p.locations;
      S.activeId = p.activeLocationId;
      renderAll();
    });
    api.on('settings', (p) => {
      const langChanged = p.settings.language !== S.settings.language;
      S.settings = p.settings;
      S.quietUntil = p.quietUntil;
      if (langChanged) setLang();
      renderBanner();
    });
    api.on('history', (h) => { S.history = h; renderHistory(); renderHeader(); });
    api.on('commutes', (c) => { S.commutes = c || []; renderCommutes(); });
    api.on('ui', (msg) => {
      if (!msg) return;
      if (msg.action === 'settings') { fillSettings(); if (!$('settings-dialog').open) $('settings-dialog').showModal(); }
      if (msg.action === 'locate') locateHere().catch((e) => console.warn('locate', e));
      if (msg.action === 'focus') {
        const loc = S.locations.find((l) => l.id === msg.id);
        if (loc && mapApi) mapApi.focus(loc.lat, loc.lon, 8);
      }
    });
  }

  // ------------------------------------------------------------------

  async function init() {
    const st = await api.getState();
    Object.assign(S, {
      settings: st.settings, locations: st.locations, commutes: st.commutes || [], activeId: st.activeLocationId,
      statuses: st.statuses || {}, frames: st.frames, history: st.history, error: st.error,
      systemLocale: st.systemLocale, platform: st.platform, quietUntil: st.quietUntil
    });
    document.body.classList.add('platform-' + st.platform);
    $('version').textContent = `Chubasco ${st.version}`;
    setLang();
    wireGlobal();
    wireSettings();
    wireAlarm();
    wireEvents();
    initMap();
    renderAll();
    if (!active()) setTimeout(() => $('onboard-search').focus(), 300);
  }

  init();
})();
