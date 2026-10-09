// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage,
  nativeTheme, shell, powerMonitor, net, screen, session, clipboard
} = require('electron');

const { Store } = require('./store');
const { OperaSource } = require('./opera');
const { WeatherSource } = require('./weather');
const { Monitor } = require('./monitor');
const { ClutterStore } = require('./clutter');
const { Verifier, calibrateRadar } = require('./verify');
const { LightningSource } = require('./lightning');
const { sendPush, newTopic } = require('./push');
const Commute = require('./commute');
const { Updater, repoInfo } = require('./updates');
const P = require('../shared/palette');
const { inQuietHours, quietEnds } = require('./alerts');
const I18N = require('../shared/i18n');
const D = require('../shared/describe');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const APP_ID = 'io.github.lalesena.chubasco';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SMOKE = process.env.CHUBASCO_SMOKE === '1' && !app.isPackaged;
const DEMO = process.env.CHUBASCO_MOCK === '1' || process.argv.includes('--demo');

if (process.env.CHUBASCO_USERDATA) app.setPath('userData', process.env.CHUBASCO_USERDATA);
else if (DEMO) app.setPath('userData', path.join(app.getPath('userData'), 'demo'));

if (IS_WIN) app.setAppUserModelId(APP_ID);
if (!SMOKE && !DEMO && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let store, radar, weather, monitor, tray, win, verifier, clutter, lightning;
let mini = null, trayMenu = null, miniHiddenAt = 0, updater = null;
let widget = null, widgetDrag = null;
let quitting = false;
const startedAt = Date.now();
let lastPayload = { statuses: {}, frames: null, error: null };

const log = (...a) => { if (!app.isPackaged || process.env.CHUBASCO_DEBUG) console.log('[chubasco]', ...a); };

function userAgent() {
  return `Chubasco/${app.getVersion()} (desktop rain alarm; Electron ${process.versions.electron})`;
}

function getT() {
  return I18N.make(I18N.resolveLang(store.settings.language, app.getLocale()));
}

// --------------------------------------------------------------------------
// Ventana

function revealWindow() {
  if (win.isMinimized()) win.restore();
  win.show();
  if (IS_MAC && app.dock) {
    app.dock.show().then(() => { app.focus({ steal: true }); win.focus(); }).catch(() => {});
  } else {
    win.focus();
  }
}

function hideWindow() {
  // Ocultar una ventana a pantalla completa deja un escritorio negro en macOS.
  if (win.isFullScreen()) {
    win.once('leave-full-screen', () => hideWindow());
    win.setFullScreen(false);
    return;
  }
  win.hide();
  if (IS_MAC && app.dock) app.dock.hide();
}

function createWindow({ show = true } = {}) {
  if (win && !win.isDestroyed()) {
    if (show) revealWindow();
    return win;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1320, area.width - 80),
    height: Math.min(860, area.height - 80),
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Chubasco',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1b26' : '#eef2f5',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    icon: IS_MAC ? undefined : path.join(ASSETS, 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  const indexFile = path.join(__dirname, '..', 'renderer', 'index.html');
  win.loadFile(indexFile);
  win.once('ready-to-show', () => { if (show) revealWindow(); });

  win.on('close', (e) => {
    if (quitting || !store.settings.closeToTray) return;
    e.preventDefault();
    hideWindow();
    if (!store.settings.trayHintShown) {
      store.updateSettings({ trayHintShown: true });
      const t = getT();
      showNotification(t('notif.tray.title'), t(IS_MAC ? 'notif.tray.body' : 'notif.tray.bodyWin'), { force: true });
    }
  });
  win.on('show', () => { if (IS_MAC && app.dock) app.dock.show().catch(() => {}); });
  // Sin "seguir en segundo plano", cerrar la ventana cierra la app aunque
  // queden el widget o el mini panel (salvo en macOS, que sigue hasta ⌘Q).
  win.on('closed', () => { if (!quitting && !IS_MAC && !store.settings.closeToTray) { quitting = true; app.quit(); } });

  // Enlaces externos al navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // La ventana solo puede mostrar la propia interfaz (ni archivos arrastrados ni webs).
  const indexUrl = require('url').pathToFileURL(indexFile).href;
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] === indexUrl) return;
    e.preventDefault();
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  return win;
}

function showWindow(selectId) {
  createWindow({ show: true });
  if (selectId && store.data.locations.some((l) => l.id === selectId)) {
    store.setActive(selectId);
    broadcastLocations();
    send('ui', { action: 'focus', id: selectId });
  }
}

function send(channel, payload) {
  for (const w of [win, mini, widget]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

// --------------------------------------------------------------------------
// Mini panel de la barra de menú (clic en el icono)

const MINI_W = 340;

function createMini() {
  if (mini && !mini.isDestroyed()) return mini;
  mini = new BrowserWindow({
    width: MINI_W, height: 420, show: false, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f202c' : '#f6f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false
    }
  });
  if (IS_MAC) mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mini.loadFile(path.join(__dirname, '..', 'renderer', 'mini.html'));
  mini.on('blur', () => { if (!SMOKE) hideMini(); });
  mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mini.webContents.on('will-navigate', (e) => e.preventDefault());
  return mini;
}

function positionMini() {
  if (!mini || !tray) return;
  const b = tray.getBounds();
  const [w, h] = mini.getSize();
  const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
  let x = Math.round(b.x + b.width / 2 - w / 2);
  // Barra arriba (macOS) → debajo del icono; barra de tareas abajo (Windows) → encima.
  let y = b.y + b.height / 2 < area.y + area.height / 2 ? b.y + b.height + 4 : b.y - h - 4;
  if (!b.width) { x = area.x + area.width - w - 8; y = area.y + 8; } // sin posición conocida
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - w - 4));
  y = Math.max(area.y + 4, Math.min(y, area.y + area.height - h - 4));
  mini.setPosition(x, y, false);
}

function showMini() {
  createMini();
  positionMini();
  mini.show();
  mini.focus();
  mini.webContents.send('ui', { action: 'mini-shown' });
}

function hideMini() {
  if (mini && !mini.isDestroyed() && mini.isVisible()) { mini.hide(); miniHiddenAt = Date.now(); }
}

function toggleMini() {
  // El clic en el icono quita el foco al panel (y lo oculta) justo antes de llegar aquí.
  if (mini && !mini.isDestroyed() && mini.isVisible()) { hideMini(); return; }
  if (Date.now() - miniHiddenAt < 300) return;
  showMini();
}

// --------------------------------------------------------------------------
// Widget de escritorio: ventana pequeña sin marco que se queda donde la
// pongas. Se arrastra desde cualquier punto (lo mueve este proceso siguiendo
// al cursor) y un clic sin arrastrar abre la app.

const WIDGET_SIZES = { small: [170, 170], medium: [360, 170], large: [360, 400] };

function widgetBounds() {
  const w = store.settings.widget;
  const [width, height] = WIDGET_SIZES[w.size] || WIDGET_SIZES.medium;
  const saved = Number.isFinite(w.x) && Number.isFinite(w.y);
  const area = (saved ? screen.getDisplayMatching({ x: w.x, y: w.y, width, height }) : screen.getPrimaryDisplay()).workArea;
  // Por defecto, arriba a la derecha; y nunca fuera de la pantalla (p. ej. al desconectar un monitor).
  const x = saved ? w.x : area.x + area.width - width - 24;
  const y = saved ? w.y : area.y + 24;
  return {
    x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
    width, height
  };
}

function createWidget() {
  widget = new BrowserWindow({
    ...widgetBounds(),
    show: false, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, acceptFirstMouse: true, title: 'Chubasco', backgroundColor: '#00000000',
    // macOS: material translúcido del sistema, como sus widgets; en Windows la tarjeta la dibuja la página.
    ...(IS_MAC ? { vibrancy: 'popover', visualEffectState: 'active' } : { transparent: true }),
    ...(IS_WIN ? { type: 'toolbar' } : {}), // fuera de Alt+Tab
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false
    }
  });
  if (IS_MAC) widget.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  widget.setAlwaysOnTop(!!store.settings.widget.onTop, 'floating');
  widget.loadFile(path.join(__dirname, '..', 'renderer', 'widget.html'));
  widget.once('ready-to-show', () => { if (widget) widget.showInactive(); });
  widget.on('closed', () => { widget = null; widgetDrag = null; });
  widget.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  widget.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** Muestra, oculta o recoloca el widget según los ajustes. */
function applyWidget() {
  const w = store.settings.widget;
  if (!w.enabled) {
    if (widget && !widget.isDestroyed()) widget.close();
    return;
  }
  if (!widget || widget.isDestroyed()) { createWidget(); return; }
  widget.setBounds(widgetBounds());
  widget.setAlwaysOnTop(!!w.onTop, 'floating');
}

function setWidget(patch) {
  store.updateSettings({ widget: patch });
  applyWidget();
  afterSettingsChange();
}

function widgetMenu() {
  const t = getT();
  const w = store.settings.widget;
  const pinned = store.data.locations.some((l) => l.id === w.locationId);
  Menu.buildFromTemplate([
    {
      label: t('widget.size'),
      submenu: ['small', 'medium', 'large'].map((size) => ({ label: t('widget.' + size), type: 'radio', checked: w.size === size, click: () => setWidget({ size }) }))
    },
    {
      label: t('widget.location'),
      submenu: [{ label: t('widget.followActive'), type: 'radio', checked: !pinned, click: () => setWidget({ locationId: null }) }]
        .concat(store.data.locations.map((l) => ({ label: l.name, type: 'radio', checked: pinned && w.locationId === l.id, click: () => setWidget({ locationId: l.id }) })))
    },
    { label: t('widget.onTop'), type: 'checkbox', checked: !!w.onTop, click: (mi) => setWidget({ onTop: mi.checked }) },
    { type: 'separator' },
    { label: t('tray.check'), click: () => monitor.checkNow() },
    { label: t('tray.open'), click: () => showWindow() },
    { type: 'separator' },
    { label: t('widget.hide'), click: () => setWidget({ enabled: false }) }
  ]).popup({ window: widget });
}

/** start / move / end: el widget sigue al cursor desde donde empezó el arrastre. */
function dragWidget(phase) {
  if (!widget || widget.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  if (phase === 'start') {
    const [x, y] = widget.getPosition();
    widgetDrag = { x, y, cx: c.x, cy: c.y };
  } else if (widgetDrag && phase === 'move') {
    widget.setPosition(Math.round(widgetDrag.x + c.x - widgetDrag.cx), Math.round(widgetDrag.y + c.y - widgetDrag.cy));
  } else if (widgetDrag && phase === 'end') {
    widgetDrag = null;
    const [x, y] = widget.getPosition();
    store.updateSettings({ widget: { x, y } });
    widget.setBounds(widgetBounds());
  }
}

// --------------------------------------------------------------------------
// Avisos

// Las notificaciones se guardan para que el recolector de basura no se lleve
// su manejador de clic (ni la propia notificación en macOS).
const liveNotifications = new Set();

function attention() {
  if (IS_MAC && app.dock && app.dock.isVisible()) app.dock.bounce('informational');
  else if (win && !win.isDestroyed()) win.flashFrame(true);
}

function showNotification(title, body, { force = false, locationId } = {}) {
  if (!Notification.isSupported()) { attention(); return; }
  const n = new Notification({
    title, body,
    silent: !store.settings.sound,
    icon: IS_MAC ? undefined : path.join(ASSETS, 'icon-512.png')
  });
  liveNotifications.add(n);
  const drop = () => liveNotifications.delete(n);
  n.on('click', () => { drop(); showWindow(locationId); });
  n.on('close', drop);
  n.on('failed', (_e, err) => { drop(); log('notif failed', err); attention(); });
  // Límite de seguridad: no acumular indefinidamente.
  if (liveNotifications.size > 30) liveNotifications.delete(liveNotifications.values().next().value);
  n.show();
  if (!force) log('notif', title, '|', body);
}

function silencedReason() {
  const s = store.settings;
  if (s.snoozeUntil && s.snoozeUntil > Date.now()) return 'snoozed';
  if (inQuietHours(s.quietHours)) return 'quiet';
  return null;
}

/** Copia del aviso en el móvil (ntfy), si está activado. */
function pushAlert(title, body, type, { force = false } = {}) {
  const p = store.settings.push;
  if (!force && !(p && p.enabled)) return Promise.resolve(false);
  return sendPush({ fetch: (u, o) => net.fetch(u, { ...o, signal: AbortSignal.timeout(15000) }), userAgent: userAgent(), push: p, title, body, type })
    .then(() => true)
    .catch((e) => { log('push', e.message); if (force) throw e; return false; });
}

function onAlerts(loc, alerts) {
  for (const a of alerts) {
    // "Avísame cuando pare" lo ha pedido el usuario: suena aunque haya silencio.
    const reason = a.type === 'dryWindow' ? null : silencedReason();
    store.addHistory({
      ts: Date.now(), locationId: loc.id, locationName: loc.name,
      type: a.type, title: a.title, body: a.body, silenced: reason
    });
    if (!reason) { showNotification(a.title, a.body, { locationId: loc.id }); pushAlert(a.title, a.body, a.type); }
    if (a.type === 'dryWindow') setDryWatch(loc.id, null);
  }
  send('history', store.data.history);
}

/** Activa (minutos secos) o cancela (null) el aviso "cuando pare" de una ubicación. */
function setDryWatch(id, minMin) {
  if (!store.updateLocation(id, { dryWatch: minMin ? { minMin } : null })) return;
  broadcastLocations();
}

/** Quita los avisos "cuando pare" caducados (se llama cada minuto). */
function expireDryWatches() {
  for (const l of store.data.locations) if (l.dryWatch && l.dryWatch.until < Date.now()) setDryWatch(l.id, null);
}

// --------------------------------------------------------------------------
// Bandeja / barra de menú

const SEVERITY = ['unknown', 'clear', 'nearby', 'approaching', 'imminent', 'raining'];

function trayImage(state) {
  const name = IS_MAC ? `${state}Template` : state;
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray', `${name}.png`));
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}

function locationSummaries() {
  const t = getT();
  return store.data.locations.map((loc) => {
    const st = lastPayload.statuses[loc.id];
    return { loc, d: D.describe(st, loc, store.settings, t) };
  });
}

function updateTray() {
  if (!tray) return;
  const t = getT();
  const sums = locationSummaries();
  let worst = sums.length ? 'clear' : 'unknown';
  let worstShort = '';
  for (const { d } of sums) {
    if (SEVERITY.indexOf(d.level) > SEVERITY.indexOf(worst)) { worst = d.level; worstShort = d.short || ''; }
  }
  if (sums.length && sums.every(({ d }) => d.level === 'unknown')) worst = 'unknown';
  const snoozed = store.settings.snoozeUntil > Date.now();
  tray.setImage(trayImage(snoozed && worst === 'clear' ? 'snoozed' : worst));
  if (IS_MAC) tray.setTitle(worst === 'imminent' || worst === 'approaching' ? worstShort : '', { fontType: 'monospacedDigit' });

  const tip = sums.length
    ? sums.map(({ loc, d }) => `${loc.name}: ${d.headline}`).join('\n')
    : t('tray.noLocations');
  tray.setToolTip(`Chubasco\n${tip}`.slice(0, 127));

  const items = [];
  if (!sums.length) items.push({ label: t('tray.noLocations'), enabled: false });
  for (const { loc, d } of sums) {
    items.push({ label: `${loc.name} — ${d.headline}`, click: () => showWindow(loc.id) });
  }
  // "Avísame cuando pare" donde está lloviendo.
  for (const { loc, d } of sums) {
    if (loc.dryWatch) items.push({ label: t('tray.dryWatchCancel', { place: loc.name }), click: () => setDryWatch(loc.id, null) });
    else if (d.level === 'raining') items.push({ label: t('tray.dryWatch', { place: loc.name }), click: () => setDryWatch(loc.id, 30) });
  }
  items.push({ type: 'separator' });
  if (snoozed) {
    items.push({ label: t('tray.snoozedUntil', { time: D.fmtClock(t, store.settings.snoozeUntil) }), enabled: false });
    items.push({ label: t('tray.resume'), click: () => snooze(0) });
  } else {
    items.push({
      label: t('tray.snooze'),
      submenu: [
        { label: t('tray.snooze1'), click: () => snooze(60) },
        { label: t('tray.snooze3'), click: () => snooze(180) },
        { label: t('tray.snoozeTomorrow'), click: () => snoozeUntilTomorrow() }
      ]
    });
  }
  items.push({ label: t('tray.check'), click: () => monitor.checkNow() });
  const up = updater && updater.available;
  if (up) {
    items.push(up.ready
      ? { label: t('tray.updateInstall', { version: up.version }), click: () => updater.installNow() }
      : { label: t('tray.updateDownload', { version: up.version }), click: () => shell.openExternal(up.url) });
  }
  items.push({ type: 'separator' });
  items.push({ label: t('tray.open'), click: () => showWindow() });
  items.push({
    label: t('tray.widget'), type: 'checkbox', checked: !!store.settings.widget.enabled,
    click: (mi) => setWidget({ enabled: mi.checked })
  });
  items.push({
    label: t('tray.login'), type: 'checkbox', checked: !!store.settings.launchAtLogin,
    click: (mi) => setLaunchAtLogin(mi.checked)
  });
  items.push({ type: 'separator' });
  items.push({ label: t('tray.quit'), accelerator: IS_MAC ? 'Cmd+Q' : undefined, click: () => { quitting = true; app.quit(); } });
  // Sin setContextMenu: el clic abre el mini panel y el clic derecho, el menú.
  trayMenu = Menu.buildFromTemplate(items);
}

function createTray() {
  tray = new Tray(trayImage('unknown'));
  tray.on('click', (e) => { if (e && (e.ctrlKey || e.metaKey)) tray.popUpContextMenu(trayMenu); else toggleMini(); });
  tray.on('right-click', () => { hideMini(); tray.popUpContextMenu(trayMenu); });
  if (!IS_MAC) tray.on('double-click', () => { hideMini(); showWindow(); });
  updateTray();
}

function snooze(minutes) {
  store.updateSettings({ snoozeUntil: minutes ? Date.now() + minutes * 60000 : 0 });
  afterSettingsChange();
}

function snoozeUntilTomorrow() {
  // Hasta las próximas 8:00 (hoy si aún no han llegado).
  const d = new Date();
  if (d.getHours() >= 8) d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  store.updateSettings({ snoozeUntil: d.getTime() });
  afterSettingsChange();
}

function setLaunchAtLogin(on) {
  store.updateSettings({ launchAtLogin: !!on });
  try {
    if (app.isPackaged) {
      if (IS_WIN) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
      else app.setLoginItemSettings({ openAtLogin: !!on });
    }
  } catch (e) { log('login item', e.message); }
  afterSettingsChange();
}

function afterSettingsChange() {
  updateTray();
  send('settings', { settings: store.settings, quietUntil: quietUntil() });
}

function quietUntil() {
  const q = store.settings.quietHours;
  return inQuietHours(q) ? quietEnds(q) : 0;
}

function appMenu() {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  const t = getT();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Chubasco',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: t('ui.settings') + '…', accelerator: 'Cmd+,', click: () => { showWindow(); send('ui', { action: 'settings' }); } },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: t('tray.quit'), accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } }
      ]
    },
    { role: 'editMenu' },
    {
      label: t('ui.radar'),
      submenu: [{ label: t('ui.checkNow'), accelerator: 'Cmd+R', click: () => monitor.checkNow() }]
        .concat(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])
    },
    { role: 'windowMenu' }
  ]));
}

// --------------------------------------------------------------------------
// Resumen diario

function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Se llama cada minuto: manda el resumen del día una vez, a la hora elegida. */
function maybeDailySummary() {
  const ds = store.settings.dailySummary;
  if (!ds || !ds.enabled) return;
  const now = new Date();
  const key = localDayKey(now);
  if (store.settings.lastSummaryDay === key) return;
  const [h, m] = String(ds.time || '07:30').split(':').map(Number);
  const due = new Date(now);
  due.setHours(h || 0, m || 0, 0, 0);
  if (now < due) return;
  const done = () => store.updateSettings({ lastSummaryDay: key });
  if (now - due > 4 * 3600000) { done(); return; } // el equipo estuvo apagado: hoy ya no
  if (silencedReason()) return;                     // sale al terminar el silencio
  const locs = store.data.locations.filter((l) => l.alarm.enabled);
  if (!locs.length) { done(); return; }
  const t = getT();
  const lines = [];
  for (const loc of locs) {
    const txt = D.daySummary(t, lastPayload.statuses[loc.id], store.settings, now.getTime());
    if (txt) lines.push({ loc, txt });
  }
  // Espera un poco a que llegue la previsión del modelo de todas las ubicaciones.
  if (lines.length < locs.length && (now - due < 30 * 60000 || Date.now() - startedAt < 5 * 60000)) return;
  done();
  if (!lines.length) return;
  const first = lines[0].loc;
  const title = lines.length === 1 ? t('summary.title', { place: first.name }) : t('summary.titleMany');
  const body = lines.length === 1 ? lines[0].txt : lines.slice(0, 4).map((x) => `${x.loc.name}: ${x.txt}`).join('\n');
  store.addHistory({ ts: Date.now(), locationId: first.id, locationName: first.name, type: 'summary', title, body, silenced: null });
  showNotification(title, body, { locationId: first.id });
  pushAlert(title, body, 'summary');
  send('history', store.data.history);
}

// --------------------------------------------------------------------------
// Trayectos

/** Calcula el riesgo de lluvia de un trayecto. manual: próxima salida aunque hoy no toque. */
async function checkCommute(c, { manual = false } = {}) {
  const from = store.data.locations.find((l) => l.id === c.fromId);
  const to = store.data.locations.find((l) => l.id === c.toId);
  if (!from || !to) return null;
  const now = Date.now();
  let depTs = Commute.departureToday(c, now);
  if (depTs === null || depTs < now - 5 * 60000) {
    if (!manual) return null;
    const d = new Date(now);
    const [h, m] = String(c.time).split(':').map(Number);
    d.setHours(h || 0, m || 0, 0, 0);
    if (d.getTime() < now) d.setDate(d.getDate() + 1);
    depTs = d.getTime();
  }
  const points = Commute.routePoints(from, to);
  const mid = { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 };
  const half = Commute.distanceKm(from, to) / 2;
  const alarm = from.alarm;
  const [radarRes, model] = await Promise.all([
    radar.analyze({ id: 'commute:' + c.id, ...mid, alarm }, { thresholdDbz: P.LEVELS[alarm.level || 'light'], alarmRadiusKm: Math.min(90, half + 20), points })
      .catch((e) => { log('commute radar', e.message); return { ok: false }; }),
    weather.forecast(mid.lat, mid.lon).catch((e) => { log('commute model', e.message); return null; })
  ]);
  const res = Commute.evaluateCommute({ radar: calibrateRadar(radarRes, verifier.calibration()), model, alarm, points, depTs, durationMin: c.durationMin || 30, now });
  if (!res) return null;
  return Commute.commuteText(getT(), res, { fromName: from.name, toName: to.name, time: c.time, depTs, units: store.settings.units });
}

function deliverCommute(c, r, { manual = false } = {}) {
  const from = store.data.locations.find((l) => l.id === c.fromId);
  const reason = manual ? null : silencedReason();
  store.addHistory({ ts: Date.now(), locationId: c.fromId, locationName: from ? from.name : '', type: 'commute', title: r.title, body: r.body, silenced: reason });
  if (!reason) { showNotification(r.title, r.body, { locationId: c.fromId }); pushAlert(r.title, r.body, 'commute'); }
  send('history', store.data.history);
}

let commuteBusy = false;
/** Se llama cada minuto: media hora antes de cada salida, comprueba el trayecto. */
async function maybeCommutes() {
  if (commuteBusy) return;
  commuteBusy = true;
  try {
    for (const c of store.data.commutes.slice()) {
      const key = Commute.dueKey(c, Date.now());
      if (!key) continue;
      store.updateCommute(c.id, { lastKey: key });
      const r = await checkCommute(c);
      if (r && (r.maybe || !c.onlyIfRain)) deliverCommute(c, r);
    }
  } catch (e) {
    log('commute', e.message);
  } finally {
    commuteBusy = false;
  }
}

function broadcastCommutes() { send('commutes', store.data.commutes); }

// --------------------------------------------------------------------------
// "Aquí": ubicación que sigue al equipo (la interfaz obtiene la posición)

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function requestLocate() {
  if (store.data.locations.some((l) => l.follow)) send('ui', { action: 'locate' });
}

// --------------------------------------------------------------------------
// IPC

function fullState() {
  return {
    settings: store.settings,
    locations: store.data.locations,
    commutes: store.data.commutes,
    activeLocationId: store.data.activeLocationId,
    history: store.data.history,
    statuses: lastPayload.statuses,
    frames: lastPayload.frames,
    error: lastPayload.error,
    systemLocale: app.getLocale(),
    platform: process.platform,
    darkSystem: nativeTheme.shouldUseDarkColors,
    quietUntil: quietUntil(),
    version: app.getVersion()
  };
}

function broadcastLocations() {
  send('locations', { locations: store.data.locations, activeLocationId: store.data.activeLocationId });
  updateTray();
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);

function registerIpc() {
  ipcMain.handle('state:get', () => fullState());

  ipcMain.handle('settings:update', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return store.settings;
    const prevInterval = store.settings.checkIntervalMin;
    const prevLang = store.settings.language;
    if ('launchAtLogin' in patch) { setLaunchAtLogin(patch.launchAtLogin); delete patch.launchAtLogin; }
    if (patch.push) delete patch.push.topic; // el tema solo lo genera la app
    if (patch.widget) { delete patch.widget.x; delete patch.widget.y; } // la posición la pone el arrastre
    store.updateSettings(patch);
    if (patch.widget) applyWidget();
    if (store.settings.push.enabled && !store.settings.push.topic) store.updateSettings({ push: { topic: newTopic() } });
    if (store.settings.checkIntervalMin !== prevInterval) monitor.schedule();
    if (store.settings.language !== prevLang) appMenu();
    if ('theme' in patch) nativeTheme.themeSource = store.settings.theme === 'auto' ? 'system' : store.settings.theme;
    afterSettingsChange();
    return store.settings;
  });

  ipcMain.handle('location:add', async (_e, { name, lat, lon }) => {
    lat = num(lat); lon = num(lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) throw new Error('Coordenadas no válidas');
    if (!name) name = (await weather.reverse(lat, lon, getT().lang)) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    const loc = store.addLocation({ name, lat, lon });
    store.setActive(loc.id);
    broadcastLocations();
    monitor.checkNow(loc.id);
    return loc;
  });

  ipcMain.handle('location:update', async (_e, { id, patch }) => {
    if (!patch || typeof patch !== 'object') return null;
    const moved = patch.lat !== undefined || patch.lon !== undefined;
    const current = store.data.locations.find((l) => l.id === id);
    if (moved && !patch.name && current && !current.customName) {
      const name = await weather.reverse(num(patch.lat), num(patch.lon), getT().lang);
      if (name) patch.name = name;
    }
    const loc = store.updateLocation(id, patch);
    if (moved || (patch.alarm && ('radiusKm' in patch.alarm || 'level' in patch.alarm))) {
      if (moved) { monitor.forget(id); verifier.forget(id); }
      monitor.checkNow(id);
    }
    broadcastLocations();
    return loc;
  });

  ipcMain.handle('location:remove', (_e, id) => {
    store.removeLocation(id);
    monitor.forget(id);
    verifier.forget(id);
    broadcastLocations();
    broadcastCommutes();
  });

  // Posición del equipo (geolocalización del sistema o, si falla, por IP).
  ipcMain.handle('location:follow', async (_e, { lat, lon, source } = {}) => {
    lat = num(lat); lon = num(lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) throw new Error('Coordenadas no válidas');
    const t = getT();
    const nameFor = async () => {
      const city = await weather.reverse(lat, lon, t.lang);
      return city ? `${t('ui.here')} · ${city}` : t('ui.here');
    };
    let loc = store.data.locations.find((l) => l.follow);
    log('follow', source, lat.toFixed(3), lon.toFixed(3));
    if (!loc) {
      loc = store.addLocation({ name: await nameFor(), lat, lon, follow: true });
      store.setActive(loc.id);
      broadcastLocations();
      monitor.checkNow(loc.id);
      return loc;
    }
    if (distanceKm(loc, { lat, lon }) < 2) return loc;
    store.updateLocation(loc.id, { lat, lon, name: await nameFor() });
    monitor.relocate(loc.id);
    verifier.forget(loc.id);
    broadcastLocations();
    monitor.checkNow(loc.id);
    return loc;
  });

  ipcMain.handle('mini:resize', (_e, h) => {
    if (!mini || mini.isDestroyed()) return;
    const height = Math.max(160, Math.min(640, Math.round(Number(h) || 0)));
    const [, cur] = mini.getContentSize();
    if (cur !== height) { mini.setContentSize(MINI_W, height); if (mini.isVisible()) positionMini(); }
  });
  ipcMain.handle('mini:hide', () => hideMini());
  ipcMain.handle('push:test', async () => {
    const t = getT();
    await pushAlert(t('notif.push.title'), t('notif.push.body'), 'test', { force: true });
    return true;
  });
  ipcMain.handle('app:copy', (_e, text) => { if (typeof text === 'string' && text.length < 500) clipboard.writeText(text); });
  ipcMain.handle('app:showMain', (_e, id) => { hideMini(); showWindow(typeof id === 'string' ? id : undefined); });
  ipcMain.handle('widget:menu', () => { if (widget && !widget.isDestroyed()) widgetMenu(); });
  ipcMain.on('widget:drag', (_e, phase) => dragWidget(phase));

  ipcMain.handle('commute:add', (_e, c = {}) => {
    const ids = store.data.locations.map((l) => l.id);
    const days = Array.isArray(c.days) ? [...new Set(c.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [];
    if (!ids.includes(c.fromId) || !ids.includes(c.toId) || c.fromId === c.toId) throw new Error('Trayecto no válido');
    if (!/^\d{2}:\d{2}$/.test(String(c.time)) || !days.length) throw new Error('Trayecto no válido');
    const x = store.addCommute({ fromId: c.fromId, toId: c.toId, time: c.time, days, durationMin: Math.max(5, Math.min(180, Number(c.durationMin) || 30)) });
    broadcastCommutes();
    return x;
  });
  ipcMain.handle('commute:update', (_e, { id, patch } = {}) => {
    const ok = {};
    if (patch && 'enabled' in patch) ok.enabled = !!patch.enabled;
    if (patch && 'onlyIfRain' in patch) ok.onlyIfRain = !!patch.onlyIfRain;
    const c = store.updateCommute(id, ok);
    broadcastCommutes();
    return c;
  });
  ipcMain.handle('commute:remove', (_e, id) => { store.removeCommute(id); broadcastCommutes(); });
  ipcMain.handle('commute:check', async (_e, id) => {
    const c = store.data.commutes.find((x) => x.id === id);
    if (!c) return null;
    const r = await checkCommute(c, { manual: true });
    if (r) deliverCommute(c, r, { manual: true });
    return r && { title: r.title, body: r.body };
  });

  ipcMain.handle('location:dryWatch', (_e, { id, minMin } = {}) => setDryWatch(id, Number(minMin) || null));

  ipcMain.handle('verify:get', (_e, id) => ({ loc: id ? verifier.stats(id) : null, all: verifier.stats(null) }));

  // Agua en España (embalses y lluvia por cuenca): lo calcula y publica la
  // web cada hora (scripts/agua/datos.mjs); aquí solo se lee. `file` es
  // agua.json, pluvio.json o el histórico de embalses de una cuenca (embalses/ES030.json).
  const agua = new Map();
  ipcMain.handle('agua:get', async (_e, file = 'agua.json') => {
    if (!/^(agua|pluvio|embalses\/ES\d{3}|pluvio\/[0-9A-Z]{1,8})\.json$/.test(file)) throw new Error('Fichero no válido');
    const hit = agua.get(file);
    if (hit && Date.now() - hit.at < 15 * 60000) return hit.data;
    const repo = repoInfo(require('../../package.json'));
    if (!repo) throw new Error('Sin repositorio publicado');
    const res = await net.fetch(`https://${repo.owner}.github.io/${repo.repo}/agua/${file}`, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    agua.set(file, { at: Date.now(), data });
    return data;
  });

  // Previsión (viento, lluvia y temperatura de ECMWF, ICON-EU y GFS): también la publica la web
  // (scripts/viento/datos.mjs). `file` es el índice de un modelo (ecmwf/index.json) o una hora
  // de una pasada (ecmwf/2026100812/f018.gz el viento, m018.gz la lluvia y la temperatura,
  // binarios que descomprime la interfaz). De cada modelo solo se guardan las horas de su última pasada.
  const viento = new Map();
  ipcMain.handle('viento:get', async (_e, file = '') => {
    const m = /^(ecmwf|icon-eu|gfs)\/(index\.json|(\d{10})\/[fm]\d{3}\.gz)$/.exec(file);
    if (!m) throw new Error('Fichero no válido');
    const isIndex = m[2] === 'index.json';
    const hit = viento.get(file);
    if (hit && (!isIndex || Date.now() - hit.at < 10 * 60000)) return hit.data;
    const repo = repoInfo(require('../../package.json'));
    if (!repo) throw new Error('Sin repositorio publicado');
    const res = await net.fetch(`https://${repo.owner}.github.io/${repo.repo}/viento/${file}`, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = isIndex ? await res.json() : new Uint8Array(await res.arrayBuffer());
    if (!isIndex) for (const k of viento.keys()) if (k.startsWith(`${m[1]}/`) && !k.endsWith('/index.json') && !k.startsWith(`${m[1]}/${m[3]}/`)) viento.delete(k);
    viento.set(file, { at: Date.now(), data });
    return data;
  });

  // Teselas del mapa con OPERA: un byte por píxel (ver opera.js).
  ipcMain.handle('radar:tile', async (_e, q) => {
    try {
      return await radar.viewTile(q);
    } catch (e) {
      if (!e.missing) log('radar tile', e.message);
      return null;
    }
  });

  ipcMain.handle('lightning:view', async (_e, q) => {
    const MAX_M = 20037508.34;
    const b = (q && Array.isArray(q.bbox) ? q.bbox : []).map(Number);
    if (b.length !== 4 || !b.every(isFinite)) return { points: [] };
    const bbox = [Math.max(-MAX_M, b[0]), Math.max(-MAX_M, b[1]), Math.min(MAX_M, b[2]), Math.min(MAX_M, b[3])];
    if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return { points: [] };
    const size = (v) => Math.max(64, Math.min(640, Math.round(num(v)) || 256));
    try {
      return await lightning.inView(bbox, size(q.width), size(q.height));
    } catch (e) {
      log('lightning view', e.message);
      return { points: [], error: e.message };
    }
  });

  ipcMain.handle('location:setActive', (_e, id) => {
    store.setActive(id);
    broadcastLocations();
    if (!lastPayload.statuses[id]) monitor.checkNow(id);
  });

  ipcMain.handle('geo:search', (_e, q) => weather.search(String(q || '').slice(0, 100), getT().lang));
  ipcMain.handle('geo:ip', () => weather.ipLocation());

  ipcMain.handle('monitor:check', () => { monitor.checkNow(); });

  ipcMain.handle('alerts:test', (_e, id) => {
    const loc = store.data.locations.find((l) => l.id === id) || store.data.locations[0];
    const t = getT();
    showNotification(t('notif.test.title'), t('notif.test.body', { place: loc ? loc.name : '…' }), { force: true, locationId: loc && loc.id });
  });
  ipcMain.handle('alerts:snooze', (_e, minutes) => snooze(Number(minutes) || 0));
  ipcMain.handle('history:clear', () => { store.clearHistory(); send('history', store.data.history); });

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\/[\w.-]+\//.test(url)) shell.openExternal(url);
  });
}

// --------------------------------------------------------------------------
// Arranque

app.whenReady().then(() => {
  if (DEMO) require('./mock').install();
  store = new Store(app.getPath('userData'));
  if (DEMO && !store.data.locations.length) {
    const { HOME } = require('./mock');
    store.addLocation({ name: 'Madrid (demo)', lat: HOME.lat, lon: HOME.lon });
    store.addLocation({ name: 'Toledo (demo)', lat: 39.8628, lon: -4.0273 });
  }
  nativeTheme.themeSource = store.settings.theme === 'auto' ? 'system' : store.settings.theme;
  // Todas las peticiones con tiempo límite: una conexión colgada tras
  // suspender el equipo no debe bloquear la vigilancia.
  const fetchImpl = (url, opts = {}) => net.fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  // Solo se concede la ubicación (para "Aquí") y solo a la propia interfaz.
  const allowGeo = (perm, url) => perm === 'geolocation' && /^file:/.test(url || '');
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => cb(allowGeo(perm, details && details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin, details) => allowGeo(perm, (details && details.requestingUrl) || origin));
  clutter = new ClutterStore(app.getPath('userData'), { log });
  verifier = new Verifier(app.getPath('userData'), { log });
  // Radar europeo EUMETNET OPERA (CC BY 4.0). Fuera de Europa no hay radar.
  radar = new OperaSource({ fetch: fetchImpl, userAgent: userAgent(), log, clutter });
  weather = new WeatherSource({ fetch: fetchImpl, userAgent: userAgent(), log });
  lightning = new LightningSource({ fetch: fetchImpl, userAgent: userAgent(), log });
  monitor = new Monitor({
    store, radar, weather, lightning, verifier, getT, log,
    onUpdate: (payload) => {
      lastPayload = payload;
      send('status', payload);
      updateTray();
    },
    onAlerts
  });

  registerIpc();
  appMenu();
  createTray();
  if (IS_WIN && typeof Notification.handleActivation === 'function') {
    // Clics en avisos que siguen en el Centro de actividades tras reiniciar.
    Notification.handleActivation(() => showWindow());
  }

  let openedAtLogin = false;
  try { openedAtLogin = IS_MAC && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin; } catch (_) { /* nada */ }
  const hidden = process.argv.includes('--hidden') || store.settings.startHidden || openedAtLogin;
  createWindow({ show: !hidden });
  if (hidden && IS_MAC && app.dock) app.dock.hide();
  if (SMOKE && process.env.CHUBASCO_SMOKE_WIDGET) store.updateSettings({ widget: { enabled: true, size: process.env.CHUBASCO_SMOKE_WIDGET } });
  applyWidget();
  // Monitores que se conectan o cambian de resolución: el widget no debe quedar fuera.
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => { if (widget) applyWidget(); });
  monitor.start();

  updater = new Updater({
    app, pkg: require('../../package.json'), log,
    fetch: (u, o) => net.fetch(u, { ...o, signal: AbortSignal.timeout(20000) }),
    onAvailable: (info) => {
      updateTray();
      const t = getT();
      const n = new Notification({
        title: t('notif.update.title', { version: info.version }),
        body: t(info.ready ? 'notif.update.ready' : 'notif.update.download'),
        silent: true, icon: IS_MAC ? undefined : path.join(ASSETS, 'icon-512.png')
      });
      liveNotifications.add(n);
      n.on('click', () => { liveNotifications.delete(n); if (info.ready) updater.installNow(); else if (info.url) shell.openExternal(info.url); });
      n.on('close', () => liveNotifications.delete(n));
      n.show();
    }
  });
  updater.start();

  powerMonitor.on('resume', () => { setTimeout(() => monitor.checkNow(), 8000); setTimeout(requestLocate, 10000); });
  powerMonitor.on('unlock-screen', () => { setTimeout(() => monitor.checkNow(), 3000); setTimeout(requestLocate, 5000); });
  nativeTheme.on('updated', () => send('theme', nativeTheme.shouldUseDarkColors));
  // Cada minuto: menú de la bandeja (silencio, posponer) y resumen diario.
  setInterval(() => {
    updateTray();
    send('settings', { settings: store.settings, quietUntil: quietUntil() });
    maybeDailySummary();
    expireDryWatches();
    maybeCommutes();
  }, 60000);
  // "Aquí" se actualiza cada 15 min (y al despertar el equipo).
  setTimeout(requestLocate, 15000);
  setInterval(requestLocate, 15 * 60000);

  if (SMOKE) {
    const ms = Number(process.env.CHUBASCO_SMOKE_MS || 6000);
    if (process.env.CHUBASCO_SMOKE_JS) {
      setTimeout(() => win.webContents.executeJavaScript(process.env.CHUBASCO_SMOKE_JS)
        .then((r) => { if (r !== undefined) console.log('[smoke]', JSON.stringify(r)); })
        .catch((e) => console.error(e)), Number(process.env.CHUBASCO_SMOKE_JS_AT || ms - 2500));
    }
    if (process.env.CHUBASCO_SMOKE_MINI) setTimeout(showMini, 1500);
    setTimeout(async () => {
      try {
        const target = process.env.CHUBASCO_SMOKE_WIDGET ? widget : process.env.CHUBASCO_SMOKE_MINI ? mini : win;
        const img = await target.webContents.capturePage();
        require('fs').writeFileSync(process.env.CHUBASCO_SMOKE_SHOT || 'smoke.png', img.toPNG());
      } catch (e) { console.error(e); }
      quitting = true;
      app.quit();
    }, ms);
  }
});

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
  if (store) store.flush();
  if (verifier) verifier.flush();
  if (clutter) clutter.flush();
});
app.on('window-all-closed', () => {
  // Con "seguir en segundo plano" desactivado, cerrar la ventana cierra la app
  // (en macOS se mantiene la convención de seguir abierta hasta ⌘Q).
  if (!IS_MAC && store && !store.settings.closeToTray) { quitting = true; app.quit(); }
});
