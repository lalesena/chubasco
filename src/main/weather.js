'use strict';
/*
 * Open-Meteo (gratis, sin clave, uso no comercial): previsión de
 * precipitación cada 15 min y por horas, y búsqueda de lugares.
 * Nominatim (OpenStreetMap) para poner nombre a un punto del mapa.
 * ipwho.is / ipapi.co para la ubicación aproximada por IP (solo si se pide).
 */

class WeatherSource {
  constructor({ fetch, userAgent, log = () => {} }) {
    this.fetch = fetch;
    this.userAgent = userAgent;
    this.log = log;
  }

  async json(url, extraHeaders = {}) {
    const res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent, ...extraHeaders } });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${new URL(url).host})`);
    return res.json();
  }

  async forecast(lat, lon) {
    const q = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      current: 'temperature_2m,precipitation,weather_code,wind_speed_10m,is_day',
      minutely_15: 'precipitation,snowfall',
      hourly: 'precipitation_probability,precipitation,temperature_2m,weather_code',
      forecast_minutely_15: '24',
      past_minutely_15: '0',
      forecast_hours: '24',
      timezone: 'auto',
      timeformat: 'unixtime',
      wind_speed_unit: 'kmh'
    });
    const j = await this.json(`https://api.open-meteo.com/v1/forecast?${q}`);
    const m = j.minutely_15 || {};
    const h = j.hourly || {};
    const minutely = (m.time || []).map((t, i) => ({
      t: t * 1000,
      precip: num(m.precipitation, i), // mm en 15 min
      snow: num(m.snowfall, i)          // cm en 15 min
    }));
    const hourly = (h.time || []).map((t, i) => ({
      t: t * 1000,
      prob: num(h.precipitation_probability, i),
      precip: num(h.precipitation, i),
      temp: num(h.temperature_2m, i),
      code: num(h.weather_code, i)
    }));
    const c = j.current || {};
    const nextRain = hourly.find((x) => (x.precip || 0) >= 0.2 || (x.prob || 0) >= 50) || null;
    return {
      ok: true,
      updatedAt: Date.now(),
      utcOffset: j.utc_offset_seconds || 0,
      current: {
        temp: c.temperature_2m, precip: c.precipitation, code: c.weather_code,
        wind: c.wind_speed_10m, isDay: c.is_day
      },
      minutely, hourly, nextRain
    };
  }

  async search(query, language = 'es') {
    const q = new URLSearchParams({ name: query, count: '8', language, format: 'json' });
    const j = await this.json(`https://geocoding-api.open-meteo.com/v1/search?${q}`);
    return (j.results || []).map((r) => ({
      name: r.name,
      detail: [r.admin1, r.country].filter(Boolean).join(', '),
      lat: r.latitude,
      lon: r.longitude
    }));
  }

  async reverse(lat, lon, language = 'es') {
    try {
      const q = new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', zoom: '12', 'accept-language': language });
      const j = await this.json(`https://nominatim.openstreetmap.org/reverse?${q}`);
      const a = j.address || {};
      return a.city || a.town || a.village || a.municipality || a.suburb || a.county || j.name || null;
    } catch (e) {
      this.log('reverse', e.message);
      return null;
    }
  }

  async ipLocation() {
    try {
      const j = await this.json('https://ipwho.is/');
      if (j.success !== false && isFinite(j.latitude)) {
        return { lat: j.latitude, lon: j.longitude, name: j.city || j.region || 'Mi ubicación' };
      }
    } catch (e) { this.log('ipwho', e.message); }
    const j = await this.json('https://ipapi.co/json/');
    if (!isFinite(j.latitude)) throw new Error('No se pudo estimar la ubicación');
    return { lat: j.latitude, lon: j.longitude, name: j.city || j.region || 'Mi ubicación' };
  }
}

function num(arr, i) {
  if (!arr) return null;
  const v = arr[i];
  return v === null || v === undefined ? null : Number(v);
}

module.exports = { WeatherSource };
