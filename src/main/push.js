// SPDX-License-Identifier: AGPL-3.0-or-later
// Chubasco © 2026 lalesena · https://github.com/lalesena/chubasco · término adicional 7(b) en NOTICE
'use strict';
/*
 * Avisos en el móvil con ntfy (https://ntfy.sh): gratis, sin cuenta. Se
 * publica en un "tema" con nombre aleatorio y el móvil, con la app ntfy,
 * se suscribe a él. Quien conozca el nombre del tema puede leerlo, por eso
 * es largo y aleatorio. Solo funciona mientras el ordenador esté encendido.
 */
const crypto = require('crypto');

const TAGS = {
  imminent: ['umbrella'], inRadius: ['umbrella'], atLocation: ['umbrella'], model: ['cloud_with_rain'],
  ended: ['sun_behind_small_cloud'], dryWindow: ['sun_behind_small_cloud'], lightning: ['zap'], severe: ['warning', 'zap'],
  summary: ['calendar'], commute: ['bike'], test: ['bell']
};
const HIGH = new Set(['imminent', 'atLocation', 'lightning', 'severe', 'commute']);

function newTopic() {
  return 'chubasco-' + crypto.randomBytes(12).toString('base64url');
}

/** Publica un aviso. `push`: { enabled, server, topic }. */
async function sendPush({ fetch, userAgent, push, title, body, type }) {
  if (!push || !push.topic) throw new Error('Sin tema de ntfy');
  const server = String(push.server || 'https://ntfy.sh').replace(/\/+$/, '');
  if (!/^https:\/\//.test(server)) throw new Error('El servidor de ntfy debe usar https');
  const res = await fetch(server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({
      topic: push.topic, title, message: body,
      tags: TAGS[type] || [], priority: HIGH.has(type) ? 4 : type === 'summary' ? 2 : 3
    })
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

module.exports = { sendPush, newTopic };
