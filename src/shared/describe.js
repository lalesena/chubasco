/*
 * Convierte el estado calculado (radar + modelo) en frases para la interfaz,
 * la bandeja y los avisos. UMD: window.RA_DESCRIBE en la interfaz.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./palette'), require('./forecast'));
  else root.RA_DESCRIBE = factory(root.RA_PALETTE, root.RA_FORECAST);
})(typeof self !== 'undefined' ? self : this, function (P, F) {
  'use strict';

  const MIN = 60000;

  function locale(t) { return t.lang === 'es' ? 'es-ES' : 'en-GB'; }

  function num(t, v, digits) {
    return new Intl.NumberFormat(locale(t), { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
  }

  function fmtDist(t, km, units) {
    if (units && units.distance === 'mi') {
      const mi = km * 0.621371;
      return `${num(t, mi, mi < 10 ? 1 : 0)} mi`;
    }
    return `${num(t, km, km < 10 ? 1 : 0)} km`;
  }

  function fmtRate(t, mmh, units) {
    if (mmh === null || mmh === undefined) return '–';
    if (units && units.rate === 'in') {
      const v = mmh / 25.4;
      return `${num(t, v, v < 0.1 ? 3 : 2)} in/h`;
    }
    return `${num(t, mmh, mmh < 10 ? 1 : 0)} mm/h`;
  }

  function fmtAmount(t, mm, units) {
    if (units && units.rate === 'in') return `${num(t, mm / 25.4, 2)} in`;
    return `${num(t, mm, 1)} mm`;
  }

  function fmtSpeed(t, kmh, units) {
    if (units && units.distance === 'mi') return `${num(t, kmh * 0.621371, 0)} mph`;
    return `${num(t, kmh, 0)} km/h`;
  }

  function fmtTemp(t, c, units) {
    if (c === null || c === undefined) return '–';
    if (units && units.distance === 'mi') return `${num(t, c * 9 / 5 + 32, 0)} °F`;
    return `${num(t, c, 0)} °C`;
  }

  function fmtClock(t, ts) {
    return new Intl.DateTimeFormat(locale(t), { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  }

  function fmtWhen(t, ts) {
    const d = new Date(ts);
    const now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const time = fmtClock(t, ts);
    if (d.toDateString() === now.toDateString()) return t('time.today', { time });
    if (d.toDateString() === tomorrow.toDateString()) return t('time.tomorrow', { time });
    return t('time.at', { time });
  }

  function fmtAgo(t, ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return t('time.justNow');
    return t('time.agoMin', { n: m });
  }

  function dirIndex(deg) { return Math.round(((deg % 360) + 360) % 360 / 45) % 8; }
  function dirName(t, deg) { return t.raw('dirs')[dirIndex(deg)]; }
  function dirShort(t, deg) { return t.raw('dirsShort')[dirIndex(deg)]; }

  function levelName(t, dbz) { return t(`lvl.${P.levelOf(dbz)}`); }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /** Minutos desde que se tomó el último fotograma del radar. */
  function lagMin(r, now) {
    return r && r.frameTime ? Math.max(0, ((now || Date.now()) - r.frameTime * 1000) / 60000) : 0;
  }

  /** ETA contada desde ahora (el nowcast parte de la hora del fotograma). */
  function etaFromNow(r, now) {
    const e = r && r.nowcast ? r.nowcast.etaMin : null;
    if (e === null || e === undefined || e <= 0) return null;
    return Math.max(2, Math.round(e - lagMin(r, now)));
  }

  function endFromNow(r, now) {
    const e = r && r.nowcast ? r.nowcast.endMin : null;
    if (e === null || e === undefined) return null;
    return Math.max(5, Math.round(e - lagMin(r, now)));
  }

  function roundEta(min) {
    if (min <= 10) return min;
    return Math.round(min / 5) * 5;
  }

  function fmtDuration(t, min) {
    if (min < 60) return t('dur.min', { n: Math.max(5, Math.round(min / 5) * 5) });
    const r = Math.round(min / 5) * 5;
    const h = Math.floor(r / 60), m = r % 60;
    return m ? t('dur.hmin', { h, m }) : t('dur.h', { h });
  }

  /** Previsión combinada (radar + modelo) de una ubicación. */
  function outlook(status, loc, now) {
    return F ? F.blend(status, loc, { now: now || Date.now() }) : null;
  }

  /** "Seco hasta las 22:30 (1 h 50 min)", "Para hacia las 21:40; después…". */
  function outlookText(t, ol, now) {
    const d = ol && ol.dry;
    if (!d) return '';
    now = now || Date.now();
    const clock = (ts) => fmtClock(t, ts);
    if (d.state === 'dry') {
      if (d.dryUntil) return t('outlook.dryUntil', { time: clock(d.dryUntil), dur: fmtDuration(t, (d.dryUntil - now) / MIN) });
      return t('outlook.dryBeyond', { time: clock(d.horizonTs) });
    }
    if (!d.stopsAt) return t('outlook.noStop', { time: clock(d.horizonTs) });
    if (d.dryUntil) return t('outlook.stopsDryUntil', { time: clock(d.stopsAt), until: clock(d.dryUntil), dur: fmtDuration(t, (d.dryUntil - d.stopsAt) / MIN) });
    return t('outlook.stopsDryBeyond', { time: clock(d.stopsAt), until: clock(d.horizonTs) });
  }

  const SEVERE_DBZ = 55;   // núcleo muy intenso…
  const EXTREME_DBZ = 60;  // …o extremo (aunque no haya datos de rayos)

  /**
   * Tormenta fuerte cerca: núcleo de radar ≥ 55 dBZ a menos de max(radio, 30 km)
   * con rayos recientes alrededor, o ≥ 60 dBZ. Señal de posible granizo y
   * rachas fuertes (con datos gratuitos no se puede detectar el granizo).
   */
  function severeStorm(status, loc) {
    const r = status && status.radar;
    const s = r && r.ok ? r.strongest : null;
    if (!s || s.kind === P.KIND_SNOW || s.dbz < SEVERE_DBZ) return null;
    const range = Math.max(30, (loc && loc.alarm && loc.alarm.radiusKm) || 25);
    if (s.distanceKm > range) return null;
    const lg = status.lightning;
    const ln = lg && lg.ok && lg.nearest && lg.nearest.ageMin <= 30 && lg.nearest.distanceKm <= range + 10 ? lg.nearest : null;
    if (!ln && s.dbz < EXTREME_DBZ) return null;
    return { dbz: s.dbz, distanceKm: s.distanceKm, bearingDeg: s.bearingDeg, lightning: !!ln };
  }

  function severeText(t, sv, units) {
    if (!sv) return '';
    return t(sv.lightning ? 'detail.severe' : 'detail.severeNoLightning', { dist: fmtDist(t, sv.distanceKm, units), dir: dirName(t, sv.bearingDeg) });
  }

  /** "Rayos a 24 km al noreste (hace 22 min)" si hay actividad reciente. */
  function lightningText(t, status, units) {
    const lg = status && status.lightning;
    const n = lg && lg.ok ? lg.nearest : null;
    if (!n || n.ageMin > 30) return '';
    return t('detail.lightning', { dist: fmtDist(t, n.distanceKm, units), dir: dirName(t, n.bearingDeg), age: n.ageMin });
  }

  /** Probabilidad y margen de la hora de llegada: "70 % · entre 10 y 20 min". */
  function etaExtra(t, eta) {
    if (!eta || eta.p === null || eta.p === undefined) return [];
    const out = [t('detail.prob', { p: Math.round(eta.p * 100) })];
    if (eta.early !== null && eta.late !== null && eta.late - eta.early >= 10) {
      out.push(t('detail.range', { a: roundEta(eta.early), b: roundEta(eta.late) }));
    }
    return out;
  }

  /** Resumen del día (modelo): tramos con lluvia probable y temperaturas. */
  function daySummary(t, status, settings, now) {
    const m = status && status.model && status.model.ok ? status.model : null;
    if (!m || !m.hourly || !m.hourly.length) return null;
    now = now || Date.now();
    const units = (settings && settings.units) || {};
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const hours = m.hourly.filter((h) => h.t > now && h.t - 60 * MIN < midnight.getTime());
    if (!hours.length) return null;
    const wet = (h) => (h.precip || 0) >= 0.2 || (h.prob || 0) >= 50;
    const runs = [];
    for (const h of hours) {
      if (!wet(h)) continue;
      const last = runs[runs.length - 1];
      if (last && h.t - last.end <= 60 * MIN) {
        last.end = h.t; last.prob = Math.max(last.prob, h.prob || 0); last.mm += h.precip || 0;
      } else {
        runs.push({ start: Math.max(now, h.t - 60 * MIN), end: h.t, prob: h.prob || 0, mm: h.precip || 0 });
      }
    }
    const storms = hours.filter((h) => h.code === 95 || h.code === 96 || h.code === 99);
    const hail = storms.some((h) => h.code === 96 || h.code === 99);
    const stormTxt = storms.length
      ? t(hail ? 'summary.stormsHail' : 'summary.storms', { from: fmtClock(t, Math.max(now, storms[0].t - 60 * MIN)), to: fmtClock(t, storms[storms.length - 1].t) })
      : '';
    const temps = hours.map((h) => h.temp).filter((v) => v !== null && v !== undefined);
    const tempTxt = temps.length
      ? t('summary.temps', { min: fmtTemp(t, Math.min(...temps), units), max: fmtTemp(t, Math.max(...temps), units) })
      : '';
    if (!runs.length) return [t('summary.dry'), stormTxt, tempTxt].filter(Boolean).join(' ');
    const parts = runs.slice(0, 3).map((r) => t('summary.run', { from: fmtClock(t, r.start), to: fmtClock(t, r.end), prob: Math.round(r.prob) }));
    const mm = runs.reduce((s, r) => s + r.mm, 0);
    return [cap(parts.join(', ')) + '.', mm >= 0.1 ? t('summary.total', { amount: fmtAmount(t, mm, units) }) : '', stormTxt, tempTxt]
      .filter(Boolean).join(' ');
  }

  /**
   * Devuelve { level, headline, detail, short, dbz, kind, etaMin }.
   * level: unknown | clear | nearby | approaching | imminent | raining
   */
  function describe(status, loc, settings, t, now) {
    now = now || Date.now();
    const units = (settings && settings.units) || {};
    const alarm = (loc && loc.alarm) || {};
    const thr = P.LEVELS[alarm.level || 'light'];
    const radiusKm = alarm.radiusKm || 25;
    const imminentMin = alarm.imminentMin || 30;
    const r = status && status.radar;
    const m = status && status.model;
    const ol = outlook(status, loc, now);
    const out = (o) => ({ outlook: outlookText(t, ol, now), lightning: lightningText(t, status, units), severe: severeText(t, severeStorm(status, loc), units), ...o });

    const modelLine = () => {
      if (!m || !m.ok) return '';
      if (m.nextRain) {
        const when = fmtWhen(t, m.nextRain.t);
        return m.nextRain.prob !== null && m.nextRain.prob !== undefined
          ? t('detail.modelNext', { when, prob: Math.round(m.nextRain.prob) })
          : t('detail.modelNextNoProb', { when });
      }
      return t('detail.modelDry');
    };

    if (!status || (!r && !m)) {
      return { level: 'unknown', headline: t('status.loading'), detail: '', short: '' };
    }

    if (!r || !r.ok) {
      const err = r && r.error ? t('detail.radarError', { err: r.error }) : '';
      return out({ level: 'unknown', headline: t('status.unknown'), detail: [err, modelLine()].filter(Boolean).join(' '), short: '' });
    }

    if (lagMin(r, now) > 35) {
      return out({
        level: 'unknown', headline: t('status.stale'),
        detail: [t('detail.stale', { time: fmtClock(t, r.frameTime * 1000) }), modelLine()].filter(Boolean).join(' '),
        short: ''
      });
    }

    const mo = r.motion;
    const at = r.atLocation || {};
    const partial = r.missingFraction > 0.3 ? ' ' + t('detail.partialCoverage') : '';

    // 1. Lloviendo en la ubicación.
    if (at.dbz !== null && at.dbz !== undefined && at.dbz >= thr) {
      const snow = at.kind === P.KIND_SNOW;
      const level = levelName(t, at.dbz);
      const parts = [fmtRate(t, at.rate, units)];
      const end = ol && ol.end ? ol.end.min : null;
      if (end !== null) parts.push(t('detail.endsIn', { min: roundEta(end) }));
      return out({
        level: 'raining', dbz: at.dbz, kind: at.kind,
        headline: t(snow ? 'status.snowing' : 'status.raining', { level }),
        detail: cap(parts.join(' · ')) + partial,
        short: snow ? '❄' : '☂'
      });
    }

    const n = r.nearest;
    // Solo cuenta como "llega en X min" lo que sostiene el radar (peso ≥ 50 %);
    // lo que dice sobre todo el modelo va en la ventana seca.
    const eta = F && F.radarEta(ol) && ol.eta.min <= 120 ? ol.eta : null;
    const movingTxt = () => {
      if (!mo || mo.speedKmh < 3) return t('detail.still');
      if (n && !r.approaching) return t('detail.leaving');
      return t('detail.moving', { dir: dirName(t, mo.headingDeg), speed: fmtSpeed(t, mo.speedKmh, units) });
    };

    // 2. Previsión de llegada (aunque el eco aún esté fuera del radio).
    const na = n || r.nearestAny;
    if (eta) {
      const snow = na ? na.kind === P.KIND_SNOW : false;
      const level = eta.min <= imminentMin ? 'imminent' : 'approaching';
      const parts = [];
      if (na) {
        parts.push(levelName(t, na.dbz));
        parts.push(t('detail.at', { dist: fmtDist(t, na.distanceKm, units), dir: dirName(t, na.bearingDeg) }));
      }
      if (mo && mo.speedKmh >= 3) parts.push(t('detail.moving', { dir: dirName(t, mo.headingDeg), speed: fmtSpeed(t, mo.speedKmh, units) }));
      parts.push(...etaExtra(t, eta));
      return out({
        level, dbz: na ? na.dbz : null, kind: na ? na.kind : 1, etaMin: eta.min,
        headline: t(snow ? 'status.snowInMin' : 'status.inMin', { min: roundEta(eta.min) }),
        detail: cap(parts.join(' · ')) + partial,
        short: `${roundEta(eta.min)}′`
      });
    }

    // 3. Lluvia dentro del radio.
    if (n && n.distanceKm <= radiusKm) {
      const snow = n.kind === P.KIND_SNOW;
      const dist = fmtDist(t, n.distanceKm, units);
      const parts = [t('detail.toDir', { dir: dirName(t, n.bearingDeg) }), levelName(t, n.dbz), movingTxt()];
      return out({
        level: r.approaching ? 'approaching' : 'nearby', dbz: n.dbz, kind: n.kind,
        headline: r.approaching && !snow ? t('status.approaching') : t(snow ? 'status.snowNearby' : 'status.nearby', { dist }),
        detail: cap(r.approaching ? [levelName(t, n.dbz), t('detail.at', { dist, dir: dirName(t, n.bearingDeg) }), movingTxt()].join(' · ') : parts.join(' · ')) + partial,
        short: r.approaching ? '↘' : ''
      });
    }

    // 4. Nada cerca.
    const closest = r.nearestAny
      ? t('detail.closest', { dist: fmtDist(t, r.nearestAny.distanceKm, units), dir: dirName(t, r.nearestAny.bearingDeg) }) +
        (r.approaching ? '' : mo && mo.speedKmh >= 3 ? ' ' + cap(t('detail.leaving')) + '.' : '')
      : '';
    return out({
      level: 'clear', dbz: null,
      headline: t('status.clear'),
      detail: [t('detail.nothingIn', { dist: fmtDist(t, radiusKm, units) }), closest, modelLine()].filter(Boolean).join(' ') + partial,
      short: ''
    });
  }

  /**
   * Versión corta para el widget: el estado de describe() y una sola línea
   * de detalle (`sub`) en lugar del párrafo completo.
   */
  function brief(status, loc, settings, t, now) {
    now = now || Date.now();
    const d = describe(status, loc, settings, t, now);
    const units = (settings && settings.units) || {};
    const r = status && status.radar && status.radar.ok ? status.radar : null;
    let sub = '', subShort = null;
    if (d.level === 'raining') {
      const at = r.atLocation;
      const ol = outlook(status, loc, now);
      const end = ol && ol.end ? ol.end.min : null;
      sub = cap([fmtRate(t, at.rate, units)].concat(end !== null ? [t('detail.endsIn', { min: roundEta(end) })] : []).join(' · '));
      if (end !== null) subShort = cap(t('detail.endsIn', { min: roundEta(end) }));
    } else if (d.etaMin !== undefined && d.etaMin !== null) {
      const ol = outlook(status, loc, now);
      sub = ol && ol.eta && ol.eta.p !== null && ol.eta.p !== undefined ? cap(t('detail.prob', { p: Math.round(ol.eta.p * 100) })) : '';
    } else if (d.level === 'nearby' || d.level === 'approaching') {
      const n = r.nearest || r.nearestAny;
      sub = n ? cap(t('detail.at', { dist: fmtDist(t, n.distanceKm, units), dir: dirName(t, n.bearingDeg) })) : '';
    } else if (d.level === 'clear') {
      sub = d.outlook || t('detail.nothingIn', { dist: fmtDist(t, (loc && loc.alarm && loc.alarm.radiusKm) || 25, units) });
      const dry = (outlook(status, loc, now) || {}).dry;
      if (dry && dry.state === 'dry') subShort = t('outlook.dryShort', { time: fmtClock(t, dry.dryUntil || dry.horizonTs) });
    }
    // subShort: la misma idea en menos espacio (widget pequeño).
    return { ...d, sub, subShort: subShort || sub };
  }

  return {
    describe, brief, outlook, outlookText, etaExtra, daySummary, lightningText, severeStorm, severeText, etaFromNow, endFromNow, lagMin,
    fmtDist, fmtRate, fmtAmount, fmtSpeed, fmtTemp, fmtClock, fmtWhen, fmtAgo, fmtDuration,
    dirName, dirShort, levelName, roundEta, cap
  };
});
