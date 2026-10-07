'use strict';
/*
 * Decide qué avisos mandar en cada comprobación, evitando repeticiones.
 * Puro y determinista (recibe `now`) para poder probarlo.
 */
const P = require('../shared/palette');
const D = require('../shared/describe');
const F = require('../shared/forecast');

const MIN = 60000;
const LEVEL_ORDER = ['none', 'drizzle', 'light', 'moderate', 'heavy', 'violent'];

function freshState() {
  return {
    lastSent: {},
    lastLevelIdx: {},
    inRadiusArmed: true,
    imminentArmed: true,
    radiusClearSince: null,
    etaClearSince: null,
    rainingSince: null,
    atLocationAlerted: false,
    wetFrames: 0,
    lastWetFrame: null,
    dryFrames: 0,
    lastDryFrame: null,
    lastEval: null,
    lightningArmed: true,
    lightningClearSince: null,
    severeArmed: true,
    severeClearSince: null
  };
}

function resetEpisode(s) {
  s.inRadiusArmed = true;
  s.imminentArmed = true;
  s.radiusClearSince = null;
  s.etaClearSince = null;
  s.rainingSince = null;
  s.atLocationAlerted = false;
  s.wetFrames = 0;
  s.lastWetFrame = null;
  s.dryFrames = 0;
  s.lastDryFrame = null;
  delete s.lastLevelIdx.inRadius;
}

function levelIdx(dbz) { return LEVEL_ORDER.indexOf(P.levelOf(dbz)); }

const STALE_MIN = 35;

/**
 * @returns {{ alerts: Array<{type,title,body}>, state }}
 */
function evaluate({ loc, status, state, now, settings, t }) {
  const base = state || freshState();
  const s = { ...freshState(), ...base, lastSent: { ...base.lastSent }, lastLevelIdx: { ...base.lastLevelIdx } };
  const alerts = [];
  const a = loc.alarm || {};

  // "Avísame cuando pare": cuando no llueve y la previsión da al menos
  // minMin minutos secos seguidos. Funciona aunque la alarma esté apagada.
  const dw = loc.dryWatch;
  const rr = status && status.radar;
  if (dw && dw.until > now && rr && rr.ok && D.lagMin(rr, now) <= STALE_MIN) {
    const ol = D.outlook(status, loc, now);
    const d = ol && ol.dry;
    const enough = (ts) => ts - now >= dw.minMin * MIN;
    if (d && !ol.wetNow && d.state === 'dry' && (d.dryUntil ? enough(d.dryUntil) : enough(d.horizonTs))) {
      const place = loc.name;
      alerts.push({
        type: 'dryWindow',
        title: t('notif.dry.title', { place }),
        body: d.dryUntil
          ? t('notif.dry.body', { time: D.fmtClock(t, d.dryUntil), dur: D.fmtDuration(t, (d.dryUntil - now) / MIN) })
          : t('notif.dry.bodyLong', { time: D.fmtClock(t, d.horizonTs) })
      });
    }
  }

  if (!a.enabled) return { alerts, state: s };

  // Tras una suspensión larga, el episodio anterior ya no cuenta: se empieza
  // de cero sin avisar (evita un "ha dejado de llover" de hace horas).
  if (s.lastEval !== null && now - s.lastEval > 30 * MIN) resetEpisode(s);
  s.lastEval = now;

  const r = status && status.radar;
  const m = status && status.model;
  const units = settings.units;
  const thr = P.LEVELS[a.level || 'light'];
  const place = loc.name;
  const since = (k) => (s.lastSent[k] ? now - s.lastSent[k] : Infinity);
  const fire = (type, title, body, dbz) => {
    alerts.push({ type, title, body });
    s.lastSent[type] = now;
    if (dbz !== undefined && dbz !== null) s.lastLevelIdx[type] = levelIdx(dbz);
  };

  const radarFresh = r && r.ok && D.lagMin(r, now) <= STALE_MIN;
  if (radarFresh) {
    const at = r.atLocation || {};
    const raining = at.dbz !== null && at.dbz !== undefined && at.dbz >= thr;
    const n = r.nearest;
    const inRadius = !!(n && n.distanceKm <= a.radiusKm);
    // Llegada según la previsión combinada (probabilidad ≥ la elegida en la
    // alarma). Lo que solo prevé el modelo tiene su propio aviso.
    const ol = D.outlook(status, loc, now);
    const etaObj = F.radarEta(ol);
    const eta = etaObj ? etaObj.min : null;
    const mo = r.motion;

    // Rearme del aviso de radio tras 20 min sin lluvia dentro.
    if (inRadius || raining) s.radiusClearSince = null;
    else {
      if (s.radiusClearSince === null) s.radiusClearSince = now;
      if (now - s.radiusClearSince >= 20 * MIN && !s.inRadiusArmed) {
        s.inRadiusArmed = true;
        delete s.lastLevelIdx.inRadius;
      }
    }
    if (eta !== null || raining) s.etaClearSince = null;
    else {
      if (s.etaClearSince === null) s.etaClearSince = now;
      if (now - s.etaClearSince >= 20 * MIN) s.imminentArmed = true;
    }

    if (raining) {
      s.dryFrames = 0;
      s.lastDryFrame = null;
      if (s.lastWetFrame !== r.frameTime) { s.wetFrames++; s.lastWetFrame = r.frameTime; }
      if (s.rainingSince === null) {
        // Empieza un episodio de lluvia en la ubicación.
        s.rainingSince = now;
        s.atLocationAlerted = false;
        delete s.lastLevelIdx.inRadius;
        if (a.atLocation && since('atLocation') > 60 * MIN) {
          const snow = at.kind === P.KIND_SNOW;
          const level = D.levelName(t, at.dbz);
          const rate = D.fmtRate(t, at.rate, units);
          const end = ol && ol.end ? ol.end.min : null;
          fire('atLocation',
            t(snow ? 'notif.atLocation.snow' : 'notif.atLocation.title', { place }),
            end ? t('notif.atLocation.bodyEnd', { level, rate, min: D.roundEta(end) })
              : t('notif.atLocation.body', { level, rate }),
            at.dbz);
          s.atLocationAlerted = true;
        }
      }
      // Mientras llueve no tiene sentido avisar de que se acerca.
      s.inRadiusArmed = false;
      s.imminentArmed = false;
    } else if (s.rainingSince !== null) {
      // Se cuentan fotogramas de radar distintos, no comprobaciones.
      if (s.lastDryFrame !== r.frameTime) { s.dryFrames++; s.lastDryFrame = r.frameTime; }
      if (s.dryFrames >= 2) {
        const announced = a.atLocation ? s.atLocationAlerted : true;
        const lasted = s.wetFrames >= 2 || now - s.rainingSince >= 10 * MIN;
        if (a.ended && announced && lasted && since('ended') > 60 * MIN) {
          fire('ended', t('notif.ended.title', { place }), t('notif.ended.body'));
        }
        s.rainingSince = null;
        s.atLocationAlerted = false;
        s.wetFrames = 0;
        s.lastWetFrame = null;
        s.dryFrames = 0;
        s.lastDryFrame = null;
        delete s.lastLevelIdx.inRadius;
      }
    }

    // Lluvia inminente (nowcast).
    let sentImminent = false;
    if (!raining && a.imminent && eta !== null && eta <= (a.imminentMin || 30) && s.imminentArmed) {
      const near = n || r.nearestAny;
      const snow = near && near.kind === P.KIND_SNOW;
      const dbz = near ? near.dbz : thr;
      const level = D.cap(D.levelName(t, dbz));
      const fromDir = near ? D.dirName(t, near.bearingDeg) : (mo ? D.dirName(t, (mo.headingDeg + 180) % 360) : '');
      const extra = D.etaExtra(t, etaObj);
      fire('imminent',
        t(snow ? 'notif.imminent.snow' : 'notif.imminent.title', { min: D.roundEta(eta), place }),
        (mo && mo.speedKmh >= 3
          ? t('notif.imminent.body', { level, dir: fromDir, speed: D.fmtSpeed(t, mo.speedKmh, units) })
          : t('notif.imminent.bodyNoSpeed', { level, dir: fromDir })) + (extra.length ? ' ' + D.cap(extra.join(' · ')) + '.' : ''),
        dbz);
      s.imminentArmed = false;
      s.inRadiusArmed = false; // ya avisado de lo mismo
      s.lastLevelIdx.inRadius = levelIdx(dbz); // referencia para avisar si empeora
      sentImminent = true;
    }

    // Lluvia dentro del radio (aviso clásico). Se repite solo si, en el mismo
    // episodio, la lluvia que se acerca es claramente más intensa.
    if (!raining && !sentImminent && a.inRadius && inRadius) {
      const idx = levelIdx(n.dbz);
      const base = s.lastLevelIdx.inRadius;
      const escalated = !s.inRadiusArmed && base !== undefined && idx > base && r.approaching &&
        since('inRadius') > 15 * MIN && since('imminent') > 15 * MIN;
      if ((s.inRadiusArmed && since('inRadius') > 45 * MIN) || escalated) {
        const snow = n.kind === P.KIND_SNOW;
        const level = D.cap(D.levelName(t, n.dbz));
        const dir = D.dirName(t, n.bearingDeg);
        const dist = D.fmtDist(t, n.distanceKm, units);
        fire('inRadius',
          t(snow ? 'notif.inRadius.snow' : 'notif.inRadius.title', { dist, place }),
          eta ? t('notif.inRadius.bodyEta', { level, dir, min: D.roundEta(eta) }) : t('notif.inRadius.body', { level, dir }),
          n.dbz);
        s.inRadiusArmed = false;
      }
    }
  }

  // Rayos vistos por satélite (independiente del radar).
  const lg = status && status.lightning;
  if (a.lightning && lg && lg.ok) {
    const nl = lg.nearest;
    const close = nl && nl.ageMin <= 30 && nl.distanceKm <= (a.lightningKm || 20) ? nl : null;
    if (close) {
      // Rearme también si el último hueco sin rayos ya duró 30 min.
      if (s.lightningClearSince !== null && now - s.lightningClearSince >= 30 * MIN) s.lightningArmed = true;
      s.lightningClearSince = null;
      if (s.lightningArmed && since('lightning') > 30 * MIN) {
        fire('lightning',
          t('notif.lightning.title', { dist: D.fmtDist(t, close.distanceKm, units), place }),
          t('notif.lightning.body', { dir: D.dirName(t, close.bearingDeg), age: close.ageMin }));
        s.lightningArmed = false;
      }
    } else {
      if (s.lightningClearSince === null) s.lightningClearSince = now;
      if (now - s.lightningClearSince >= 30 * MIN) s.lightningArmed = true;
    }
  }

  // Tormenta fuerte (posible granizo): rearme tras 60 min sin la condición.
  if (a.severe && radarFresh) {
    const sv = D.severeStorm(status, loc);
    if (sv) {
      if (s.severeClearSince !== null && now - s.severeClearSince >= 60 * MIN) s.severeArmed = true;
      s.severeClearSince = null;
      if (s.severeArmed && since('severe') > 60 * MIN) {
        fire('severe', t('notif.severe.title', { place }),
          t(sv.lightning ? 'notif.severe.body' : 'notif.severe.bodyNoLightning', { dist: D.fmtDist(t, sv.distanceKm, units), dir: D.dirName(t, sv.bearingDeg) }));
        s.severeArmed = false;
      }
    } else {
      if (s.severeClearSince === null) s.severeClearSince = now;
      if (now - s.severeClearSince >= 60 * MIN) s.severeArmed = true;
    }
  }

  // Modelo (útil sin cobertura de radar).
  if (a.model && m && m.ok && m.minutely && m.minutely.length) {
    const next = m.minutely.filter((x) => x.t >= now - 15 * MIN && x.t <= now + 60 * MIN);
    const mm = next.reduce((acc, x) => acc + (x.precip || 0), 0);
    const recentRadar = Math.min(since('inRadius'), since('imminent'), since('atLocation'));
    if (mm >= 0.5 && since('model') > 180 * MIN && recentRadar > 60 * MIN && !(s.rainingSince)) {
      fire('model', t('notif.model.title', { place }), t('notif.model.body', { amount: D.fmtAmount(t, mm, units) }));
    }
  }

  return { alerts, state: s };
}

/** ¿Estamos en horas de silencio? */
function inQuietHours(q, date = new Date()) {
  if (!q || !q.enabled) return false;
  const toMin = (s) => { const [h, mm] = String(s).split(':').map(Number); return h * 60 + (mm || 0); };
  const a = toMin(q.start), b = toMin(q.end);
  const n = date.getHours() * 60 + date.getMinutes();
  if (a === b) return false;
  return a < b ? n >= a && n < b : n >= a || n < b;
}

/** Momento en que terminan las horas de silencio (ms). */
function quietEnds(q, date = new Date()) {
  const [h, mm] = String(q.end).split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, mm || 0, 0, 0);
  if (d <= date) d.setDate(d.getDate() + 1);
  return d.getTime();
}

module.exports = { evaluate, freshState, inQuietHours, quietEnds };
