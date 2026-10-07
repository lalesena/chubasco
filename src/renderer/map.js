/* Mapa: capas base, radar animado con previsión extrapolada, ubicaciones. */
(function () {
  'use strict';
  const L = window.L;
  const P = window.RA_PALETTE;
  const D = window.RA_DESCRIBE;

  // Mapas vectoriales de OpenFreeMap: gratis, sin clave y con uso permitido
  // (CARTO y Esri exigen cuenta o clave). Cada estilo se parte en dos capas,
  // fondo y etiquetas, para que los nombres queden por encima del radar.
  const OFM = (style) => `https://tiles.openfreemap.org/styles/${style}`;
  const OFM_ATTR = '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · Datos © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const BASES = {
    light: { style: OFM('positron'), attr: OFM_ATTR },
    dark: { style: OFM('dark'), attr: OFM_ATTR },
    streets: { style: OFM('liberty'), attr: OFM_ATTR }
  };
  const styles = new Map();
  function loadStyle(url) {
    if (!styles.has(url)) {
      const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`OpenFreeMap HTTP ${r.status}`); return r.json(); });
      p.catch(() => styles.delete(url));
      styles.set(url, p);
    }
    return styles.get(url);
  }
  function splitStyle(style, lang) {
    // Nombres en el idioma de la app cuando el mapa los tiene (Sevilla, Lisboa…).
    const localize = (l) => {
      const tf = l.layout && l.layout['text-field'];
      if (!tf || lang === 'en' || !JSON.stringify(tf).includes('name')) return l;
      return { ...l, layout: { ...l.layout, 'text-field': ['coalesce', ['get', `name:${lang}`], tf] } };
    };
    return {
      base: { ...style, layers: style.layers.filter((l) => l.type !== 'symbol') },
      labels: { ...style, layers: style.layers.filter((l) => l.type === 'symbol').map(localize) }
    };
  }
  const RADAR_ATTR = 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>';
  // Rayos: Meteosat-12 Lightning Imager (EUMETSAT, CC BY 4.0). El proceso
  // principal los agrupa en puntos y aquí se dibujan como iconos de rayo.
  const BOLT = '<svg viewBox="0 0 12 16" aria-hidden="true"><path d="M7.4.5 1.3 9.1h4l-1.2 6.4 6.6-8.9H6.6L7.4.5Z"/></svg>';
  const BOLT_SIZE = [[10, 13], [12, 16], [15, 20]]; // según la densidad de destellos
  const LIGHTNING_ATTR = 'Rayos © <a href="https://www.eumetsat.int/">EUMETSAT</a> ' + new Date().getFullYear();
  const FUTURE_COUNT = 6; // previsión: 6 pasos de 10 min a partir de ahora

  // ------------------------------------------------------------------
  // Cola de descargas: RainViewer admite 100 peticiones/min por IP y el
  // monitor en segundo plano también gasta, así que el mapa se limita.

  const Scheduler = {
    cap: 20, perSec: 0.8, tokens: 20, last: performance.now(), queue: [], timer: null,
    push(job) { this.queue.push(job); this.pump(); },
    pump() {
      const now = performance.now();
      this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.perSec);
      this.last = now;
      this.queue = this.queue.filter((j) => !j.cancelled());
      this.queue.sort((a, b) => a.priority() - b.priority());
      while (this.tokens >= 1 && this.queue.length) {
        this.tokens -= 1;
        this.queue.shift().run();
      }
      if (this.queue.length && !this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 1000 / this.perSec);
      }
    }
  };

  const RadarLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('img');
      L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
      L.DomEvent.on(tile, 'error', L.Util.bind(this._raOnError, this, done, tile, coords));
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      this._raQueue(tile, this.getTileUrl(coords));
      return tile;
    },
    _raQueue(tile, url) {
      const layer = this;
      Scheduler.push({
        run: () => { tile.src = url; },
        cancelled: () => !!tile._raDead || !layer._map,
        priority: () => (layer.raPriority ? layer.raPriority() : 5)
      });
    },
    _raOnError(done, tile, coords) {
      tile._raTries = (tile._raTries || 0) + 1;
      if (tile._raTries <= 2 && !tile._raDead) {
        setTimeout(() => this._raQueue(tile, this.getTileUrl(coords)), 12000 * tile._raTries);
        return;
      }
      this._tileOnError(done, tile, new Error('tile'));
    }
  });

  function destination(lat, lon, km, bearingDeg) {
    const R = 6371.0088;
    const d = km / R, th = bearingDeg * Math.PI / 180;
    const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
  }

  function createMap(el, dom, handlers) {
    const map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      minZoom: 3,
      maxZoom: 12,
      worldCopyJump: true,
      zoomSnap: 0.5,
      wheelPxPerZoomLevel: 90,
      keyboard: true
    });
    L.control.zoom({ position: 'topright' }).addTo(map);

    map.createPane('coverage').style.zIndex = 290;
    const radarPane = map.createPane('radar');
    radarPane.style.zIndex = 300;
    radarPane.classList.add('leaflet-radar-pane');
    map.createPane('lightning').style.zIndex = 360;
    const labelsPane = map.createPane('labels');
    labelsPane.style.zIndex = 380;
    labelsPane.style.pointerEvents = 'none';

    const st = {
      t: null, baseKey: null, baseLayer: null, labelsLayer: null, baseSeq: 0, baseRetry: null,
      maps: null, layers: [], // { frame, layer, ready }
      index: 0, playing: false, timer: null,
      opts: { opacity: 0.8, smooth: true, snow: true, coverage: false, future: true },
      motion: null, anchor: null,
      coverageLayer: null,
      lightningOn: false, lightningSeq: 0, lightningGroup: L.layerGroup(),
      locLayer: L.layerGroup().addTo(map),
      overlay: L.layerGroup().addTo(map)
    };

    // ----------------------------------------------------------------
    // Capas base

    async function setBase(key) {
      const k = BASES[key] ? key : 'light'; // "satellite" ya no existe: sin clave no hay imágenes libres
      if (st.baseKey === k) return;
      st.baseKey = k;
      const my = ++st.baseSeq;
      clearTimeout(st.baseRetry);
      let parts;
      try {
        parts = splitStyle(await loadStyle(BASES[k].style), st.t ? st.t.lang : 'es');
      } catch (e) {
        // Sin conexión al arrancar: se reintenta en un rato.
        console.warn('mapa base', e);
        if (my === st.baseSeq) { st.baseKey = null; st.baseRetry = setTimeout(() => setBase(k), 30000); }
        return;
      }
      if (my !== st.baseSeq) return;
      if (st.baseLayer) map.removeLayer(st.baseLayer);
      if (st.labelsLayer) map.removeLayer(st.labelsLayer);
      st.baseLayer = L.maplibreGL({ style: parts.base, interactive: false }).addTo(map);
      st.labelsLayer = L.maplibreGL({ style: parts.labels, pane: 'labels', interactive: false }).addTo(map);
      updateAttribution();
    }

    function updateAttribution() {
      const def = BASES[st.baseKey] || BASES.light;
      dom.attribution.innerHTML = [def.attr, RADAR_ATTR].concat(st.lightningOn ? [LIGHTNING_ATTR] : []).join(' · ');
    }

    // ----------------------------------------------------------------
    // Rayos: iconos blancos, más tenues cuanto más antiguos (últimos 15 min)

    async function refreshLightning() {
      if (!st.lightningOn || document.hidden || !handlers.lightningView) return;
      const my = ++st.lightningSeq;
      const b = map.getBounds(), size = map.getSize();
      const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
      let res;
      try {
        res = await handlers.lightningView({ bbox: [sw.x, sw.y, ne.x, ne.y], width: Math.round(size.x / 2), height: Math.round(size.y / 2) });
      } catch (e) { return; }
      if (my !== st.lightningSeq || !st.lightningOn) return;
      st.lightningGroup.clearLayers();
      for (const p of (res && res.points) || []) {
        const [w, h] = BOLT_SIZE[p.level] || BOLT_SIZE[0];
        L.marker([p.lat, p.lon], {
          pane: 'lightning', interactive: false, keyboard: false,
          icon: L.divIcon({ className: `bolt age${p.age}`, html: BOLT, iconSize: [w, h], iconAnchor: [w / 2, h / 2] })
        }).addTo(st.lightningGroup);
      }
    }
    let lightningTimer = null;
    const refreshLightningSoon = () => { clearTimeout(lightningTimer); lightningTimer = setTimeout(refreshLightning, 400); };
    map.on('moveend', refreshLightningSoon);
    document.addEventListener('visibilitychange', refreshLightningSoon);
    setInterval(refreshLightning, 5 * 60000); // EUMETSAT publica un paso cada 5 min

    function setLightning({ enabled }) {
      const on = !!enabled;
      if (on === st.lightningOn) return;
      st.lightningOn = on;
      if (on) { st.lightningGroup.addTo(map); refreshLightningSoon(); } else { st.lightningGroup.clearLayers(); map.removeLayer(st.lightningGroup); }
      updateAttribution();
    }

    // ----------------------------------------------------------------
    // Radar

    function radarUrl(frame) {
      const o = st.opts;
      return `${st.maps.host}${frame.path}/512/{z}/{x}/{y}/2/${o.smooth ? 1 : 0}_${o.snow ? 1 : 0}.png`;
    }

    function makeLayer(frame) {
      const entry = { frame, ready: false };
      const layer = new RadarLayer(radarUrl(frame), {
        tileSize: 512, zoomOffset: -1, maxNativeZoom: 7, maxZoom: 12,
        opacity: 0, pane: 'radar', keepBuffer: 1, updateWhenZooming: false
      });
      layer.raPriority = () => {
        const i = st.layers.indexOf(entry);
        if (i === st.index || (st.index >= st.layers.length && i === st.layers.length - 1)) return 0;
        return 2 + (st.layers.length - 1 - i);
      };
      layer.on('loading', () => { entry.ready = false; renderTimeline(); });
      layer.on('load', () => { entry.ready = true; renderTimeline(); });
      layer.on('tileunload', (e) => { e.tile._raDead = true; });
      entry.layer = layer;
      layer.addTo(map);
      return entry;
    }

    function setFrames(maps) {
      if (!maps || !maps.frames || !maps.frames.length) return;
      const wasAtLatest = st.index >= st.layers.length - 1;
      const prevLen = st.layers.length;
      st.maps = maps;
      const keep = new Map(st.layers.map((e) => [e.frame.path, e]));
      const next = [];
      for (const f of maps.frames) {
        const e = keep.get(f.path);
        if (e) { next.push(e); keep.delete(f.path); } else next.push(makeLayer(f));
      }
      for (const e of keep.values()) map.removeLayer(e.layer);
      st.layers = next;
      if (wasAtLatest || !prevLen || st.index >= next.length) st.index = next.length - 1;
      if (st.opts.coverage) ensureCoverage();
      show();
    }

    function setRadarOptions(o) {
      const urlChange = ('smooth' in o && o.smooth !== st.opts.smooth) || ('snow' in o && o.snow !== st.opts.snow);
      st.opts = { ...st.opts, ...o };
      if (urlChange && st.maps) for (const e of st.layers) { e.ready = false; e.layer.setUrl(radarUrl(e.frame)); }
      if (st.opts.coverage) ensureCoverage();
      else if (st.coverageLayer) { map.removeLayer(st.coverageLayer); st.coverageLayer = null; }
      show();
    }

    function ensureCoverage() {
      if (st.coverageLayer || !st.maps) return;
      st.coverageLayer = new RadarLayer(`${st.maps.host}/v2/coverage/0/512/{z}/{x}/{y}/0/0_0.png`, {
        tileSize: 512, zoomOffset: -1, maxNativeZoom: 7, maxZoom: 12, opacity: 0.45, pane: 'coverage'
      });
      st.coverageLayer.raPriority = () => 1;
      st.coverageLayer.on('tileunload', (e) => { e.tile._raDead = true; });
      st.coverageLayer.addTo(map);
    }

    // Minutos de desplazamiento respecto al último fotograma para cada paso
    // de previsión (alineados con el reloj: próximos múltiplos de 5 min + 10·k).
    function futureSteps() {
      const m = st.motion;
      if (!st.opts.future || !m || !st.anchor || m.speedKmh < 3 || !st.layers.length) return [];
      const latest = st.layers[st.layers.length - 1].frame.time * 1000;
      const five = 5 * 60000;
      const start = Math.ceil((Date.now() + 60000) / five) * five;
      const out = [];
      for (let k = 0; k < FUTURE_COUNT; k++) out.push(Math.round((start + k * 600000 - latest) / 60000));
      return out;
    }

    function totalFrames() { return st.layers.length + futureSteps().length; }

    function applyFutureShift(minutes) {
      const latest = st.layers[st.layers.length - 1];
      if (!latest) return;
      const c = latest.layer.getContainer();
      if (!c) return;
      if (!minutes || !st.motion || !st.anchor) { c.style.transform = ''; return; }
      const km = (st.motion.speedKmh * minutes) / 60;
      const dest = destination(st.anchor[0], st.anchor[1], km, st.motion.headingDeg);
      const p0 = map.latLngToLayerPoint(st.anchor);
      const p1 = map.latLngToLayerPoint(dest);
      c.style.transform = `translate(${(p1.x - p0.x).toFixed(1)}px, ${(p1.y - p0.y).toFixed(1)}px)`;
    }

    function show() {
      const n = st.layers.length;
      if (!n) return;
      const fut = futureSteps();
      if (st.index >= n + fut.length) st.index = n - 1;
      const futureIdx = st.index - (n - 1); // >0 si es previsión
      st.layers.forEach((e, i) => {
        const visible = futureIdx > 0 ? i === n - 1 : i === st.index;
        e.layer.setOpacity(visible ? st.opts.opacity : 0);
      });
      // Solo el último fotograma puede ir desplazado (previsión); los demás nunca.
      st.layers.forEach((e, i) => { const c = e.layer.getContainer(); if (c && i !== n - 1) c.style.transform = ''; });
      applyFutureShift(futureIdx > 0 ? fut[futureIdx - 1] : 0);
      el.classList.toggle('future', futureIdx > 0);
      renderTimeline();
      Scheduler.pump();
    }

    function goTo(i) {
      const total = totalFrames();
      if (!total) return;
      st.index = Math.max(0, Math.min(total - 1, i));
      show();
    }
    function step(d) {
      const total = totalFrames();
      if (!total) return;
      st.index = (st.index + d + total) % total;
      show();
    }
    function goLatest() { goTo(st.layers.length - 1); }

    function scheduleNext() {
      clearTimeout(st.timer);
      if (!st.playing) return;
      const n = st.layers.length;
      const total = totalFrames();
      const hold = st.index === n - 1 || st.index === total - 1 ? 1500 : 600;
      st.timer = setTimeout(() => {
        // Salta fotogramas pasados que aún no han cargado.
        let next = (st.index + 1) % total;
        for (let k = 0; k < n && next < n - 1 && !st.layers[next].ready; k++) next = (next + 1) % total;
        st.index = next;
        show();
        scheduleNext();
      }, hold);
    }
    function play() { st.playing = true; dom.timeline.classList.add('playing'); updatePlayTitle(); scheduleNext(); }
    function pause() { st.playing = false; dom.timeline.classList.remove('playing'); updatePlayTitle(); clearTimeout(st.timer); }
    function toggle() { if (st.playing) pause(); else play(); }
    function updatePlayTitle() { if (st.t) dom.play.title = st.t(st.playing ? 'ui.pause' : 'ui.play'); }

    map.on('zoomstart', () => { for (const e of st.layers) { const c = e.layer.getContainer(); if (c) c.style.transform = ''; } });
    map.on('zoomend moveend', () => { if (st.index > st.layers.length - 1) show(); });

    // ----------------------------------------------------------------
    // Línea de tiempo

    function renderTimeline() {
      const t = st.t;
      if (!t) return;
      const n = st.layers.length;
      const fut = futureSteps();
      const total = n + fut.length;
      const track = dom.track;
      if (track.childElementCount !== total) {
        track.innerHTML = '';
        for (let i = 0; i < total; i++) {
          const b = document.createElement('button');
          b.className = 'tl-tick';
          b.type = 'button';
          b.setAttribute('role', 'option');
          b.addEventListener('click', () => { pause(); goTo(i); });
          track.appendChild(b);
        }
      }
      const latestTime = n ? st.layers[n - 1].frame.time * 1000 : Date.now();
      [...track.children].forEach((b, i) => {
        const isFuture = i >= n;
        const time = isFuture ? latestTime + fut[i - n] * 60000 : st.layers[i].frame.time * 1000;
        b.className = 'tl-tick' + (isFuture ? ' future' : '') + (i === n - 1 ? ' now' : '') +
          (i === st.index ? ' current' : '') + (!isFuture && st.layers[i].ready ? ' ready' : '');
        b.title = D.fmtClock(t, time) + (isFuture ? ` · ${t('ui.forecastTag')}` : '');
        b.setAttribute('aria-selected', i === st.index ? 'true' : 'false');
      });
      if (!n) return;
      const isFuture = st.index >= n;
      const time = isFuture ? latestTime + fut[st.index - n] * 60000 : st.layers[st.index].frame.time * 1000;
      dom.time.textContent = D.fmtClock(t, time);
      const rel = Math.round((time - Date.now()) / 60000);
      dom.rel.textContent = isFuture ? `+${rel} min · ${t('ui.forecastTag')}` : rel >= -1 ? t('ui.now') : `−${-rel} min`;
      dom.rel.classList.toggle('future', isFuture);
      const ready = st.layers.filter((e) => e.ready).length;
      dom.loading.textContent = ready < n ? t('ui.loadingFrames', { n: ready, total: n }) : '';
    }

    // ----------------------------------------------------------------
    // Leyenda

    function renderLegend(settings) {
      const t = st.t;
      const units = settings.units;
      const rows = [[P.KIND_RAIN, t('kind.rain')]];
      if (settings.showSnow) rows.push([P.KIND_SNOW, t('kind.snow')]);
      const fmt = (mmh) => {
        const v = units.rate === 'in' ? mmh / 25.4 : mmh;
        if (v < 0.1) return v.toFixed(units.rate === 'in' ? 3 : 2).replace(/^0/, '');
        if (v < 1) return v.toFixed(1).replace(/^0/, '');
        return Math.round(v).toString();
      };
      let html = '<div class="legend-wrap">';
      for (const [kind, name] of rows) {
        html += `<div class="legend-row"><span class="name">${name}</span><span class="swatches">`;
        for (const s of P.legend(kind)) html += `<span class="sw" style="background:${s.css}" title="${fmt(s.rate)} ${units.rate === 'in' ? 'in/h' : 'mm/h'}"></span>`;
        html += '</span></div>';
      }
      html += '<div class="legend-scale">';
      P.legend(P.KIND_RAIN).forEach((s, i) => { html += `<span>${i % 2 === 0 ? fmt(s.rate) : ''}</span>`; });
      html += `</div></div>`;
      dom.legend.innerHTML = html;
      dom.legend.title = units.rate === 'in' ? 'in/h' : 'mm/h';
    }

    // ----------------------------------------------------------------
    // Ubicaciones, radio, movimiento y eco más cercano

    function setLocations(locations, activeId, statuses) {
      st.locLayer.clearLayers();
      st.overlay.clearLayers();
      st.anchor = null;
      for (const loc of locations) {
        const active = loc.id === activeId;
        const icon = L.divIcon({ className: '', html: `<div class="loc-marker${active ? ' active' : ''}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
        const m = L.marker([loc.lat, loc.lon], { icon, keyboard: true, title: loc.name, zIndexOffset: active ? 1000 : 0 });
        m.on('click', () => handlers.onMarkerClick(loc.id));
        m.on('contextmenu', (e) => handlers.onContextMenu(e.latlng, e.containerPoint));
        m.addTo(st.locLayer);
        if (!active) continue;
        st.anchor = [loc.lat, loc.lon];
        if (loc.alarm && loc.alarm.enabled) {
          L.circle([loc.lat, loc.lon], {
            radius: loc.alarm.radiusKm * 1000, color: '#00a3e0', weight: 1.5, dashArray: '6 6',
            fill: true, fillOpacity: 0.04, interactive: false
          }).addTo(st.overlay);
        }
        const s = statuses && statuses[loc.id];
        const r = s && s.radar && s.radar.ok ? s.radar : null;
        const near = r && (r.nearest || r.nearestAny);
        if (near && near.distanceKm > 1) {
          const p = destination(loc.lat, loc.lon, near.distanceKm, near.bearingDeg);
          const echo = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="echo-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: true });
          if (st.t) echo.bindTooltip(`${D.fmtDist(st.t, near.distanceKm, handlers.units())} · ${D.levelName(st.t, near.dbz)}`, { direction: 'top', offset: [0, -8] });
          echo.addTo(st.overlay);
        }
        const mo = r && r.motion;
        if (mo && mo.speedKmh >= 3) {
          const len = Math.max(8, Math.min(60, mo.speedKmh * 0.5));
          const tail = destination(loc.lat, loc.lon, len / 2, (mo.headingDeg + 180) % 360);
          const tip = destination(loc.lat, loc.lon, len / 2, mo.headingDeg);
          const headL = destination(tip[0], tip[1], len * 0.22, (mo.headingDeg + 150) % 360);
          const headR = destination(tip[0], tip[1], len * 0.22, (mo.headingDeg + 210) % 360);
          const style = { color: '#ffaa00', weight: 3, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round' };
          L.polyline([[tail, tip], [headL, tip, headR]], { ...style, color: 'rgba(0,0,0,0.35)', weight: 6 }).addTo(st.overlay);
          L.polyline([[tail, tip], [headL, tip, headR]], style).addTo(st.overlay);
          if (st.t) {
            L.marker(tip, {
              icon: L.divIcon({ className: '', html: `<span class="motion-label">${D.fmtSpeed(st.t, mo.speedKmh, handlers.units())}</span>`, iconSize: null, iconAnchor: [-6, 10] }),
              interactive: false
            }).addTo(st.overlay);
          }
        }
      }
    }

    function setMotion(motion) {
      const before = futureSteps().length;
      st.motion = motion || null;
      const after = futureSteps().length;
      if (before !== after) { if (st.index >= st.layers.length + after) st.index = st.layers.length - 1; }
      show();
    }

    map.on('contextmenu', (e) => handlers.onContextMenu(e.latlng, e.containerPoint));
    map.on('moveend', () => handlers.onViewChange({ center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }));

    return {
      map,
      setT(t) {
        const relabel = st.t && st.t.lang !== t.lang && st.baseKey;
        st.t = t;
        updatePlayTitle();
        renderTimeline();
        if (relabel) { const k = st.baseKey; st.baseKey = null; setBase(k); }
      },
      setBase, setFrames, setRadarOptions, setMotion, setLocations, renderLegend, setLightning,
      play, pause, toggle, step, goLatest, goTo,
      isPlaying: () => st.playing,
      focus(lat, lon, zoom) { map.setView([lat, lon], zoom || Math.max(map.getZoom(), 7)); },
      setView(center, zoom) { map.setView(center, zoom); },
      invalidate() { map.invalidateSize(); }
    };
  }

  window.RA_MAP = { createMap };
})();
