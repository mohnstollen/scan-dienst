/* Scan-Dienst (Cloudflare Worker)

   POST /scan/<aufgabe>   Body: { bild: { data: <Base64>, mimeType: 'image/jpeg' }, kontext: { … } }
                          → { aufgabe, ergebnis }   (Aufgaben siehe src/tasks.js)
   GET  /rezept-link?url=…  → { name, ingredients, yield, url }   (schema.org/Recipe einer Webseite)
   GET  /aufgaben         → Liste der Aufgaben
   GET  /                 → Status

   Fehler: { error: '<code>' } mit passendem HTTP-Status, Codes siehe README.
   Geheimnis: GEMINI_API_KEY. Optional: GEMINI_MODEL, DEV=1 (erlaubt localhost als Herkunft). */

import { TASKS } from './tasks.js';
import { askGemini, GeminiError, DEFAULT_MODEL } from './gemini.js';
import { recipeFromLink } from './rezept-link.js';

const LINK_APPS = ['https://mohnstollen.github.io']; // wer /rezept-link nutzen darf
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_IMAGE_BASE64 = 8_000_000; // ≈ 6 MB Bild
const MAX_CONTEXT_CHARS = 3000;
const RATE = { max: 60, windowMs: 60 * 60 * 1000 }; // Scans pro IP und Stunde (je Worker-Instanz, grober Schutz)
const hits = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const task = path.startsWith('/scan/') ? TASKS[path.slice(6)] : null;
    const apps = task ? task.apps : LINK_APPS;
    const allowed = apps.includes(origin) || (env.DEV === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    const cors = { 'Access-Control-Allow-Origin': allowed ? origin : apps[0], 'Vary': 'Origin' };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    if (path === '/' && request.method === 'GET' && !url.searchParams.has('url')) {
      return json({ dienst: 'scan-dienst', aufgaben: Object.keys(TASKS), modell: env.GEMINI_MODEL || DEFAULT_MODEL, bereit: !!env.GEMINI_API_KEY }, 200, cors);
    }
    if (!allowed) return json({ error: 'origin' }, 403, cors);

    // Rezept-Link (früher eigener Worker; „/?url=“ bleibt aus Kompatibilität erhalten)
    if (request.method === 'GET' && (path === '/rezept-link' || (path === '/' && url.searchParams.has('url')))) {
      const { status, body } = await recipeFromLink(url.searchParams.get('url'));
      return json(body, status, cors);
    }

    if (request.method === 'GET' && path === '/aufgaben') {
      return json(Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, { beschreibung: t.beschreibung, kontext: Object.keys(t.kontext || {}) }])), 200, cors);
    }

    if (path.startsWith('/scan/')) {
      if (!task) return json({ error: 'unknown_task' }, 404, cors);
      if (request.method !== 'POST') return json({ error: 'method' }, 405, cors);
      if (limited(request.headers.get('CF-Connecting-IP') || 'local')) return json({ error: 'rate_limit' }, 429, cors);

      let input;
      try { input = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
      const bild = input && input.bild;
      if (!bild || typeof bild.data !== 'string' || !bild.data) return json({ error: 'no_image' }, 400, cors);
      if (!IMAGE_TYPES.includes(bild.mimeType)) return json({ error: 'image_type' }, 415, cors);
      if (bild.data.length > MAX_IMAGE_BASE64) return json({ error: 'too_large' }, 413, cors);

      try {
        const ergebnis = await askGemini(env, task, { data: bild.data, mimeType: bild.mimeType }, contextText(task, input.kontext));
        return json({ aufgabe: path.slice(6), ergebnis }, 200, cors);
      } catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        console.log('Gemini-Fehler', e.code, e.status, e.detail || '');
        return json({ error: e.code }, e.status, cors);
      }
    }

    return json({ error: 'not_found' }, 404, cors);
  }
};

/* Nur die in der Aufgabe erlaubten Kontextfelder übernehmen, als lesbaren Text */
function contextText(task, kontext) {
  if (!kontext || typeof kontext !== 'object' || !task.kontext) return '';
  const lines = [];
  for (const [key, explanation] of Object.entries(task.kontext)) {
    const v = kontext[key];
    const value = Array.isArray(v) ? v.filter(x => typeof x === 'string').join(', ') : typeof v === 'string' ? v : '';
    if (value.trim()) lines.push(`${key}: ${value.trim()} (${explanation})`);
  }
  return lines.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE.max;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
