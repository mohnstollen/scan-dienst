/* Tests für den Worker: startet ihn lokal (wrangler unstable_dev) gegen einen nachgebauten Gemini-Server.
   Aufruf: npm test */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { unstable_dev } from 'wrangler';

const ORIGIN = 'https://mohnstollen.github.io';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let mock, mockUrl, worker, workerNoKey;
let lastGeminiRequest = null;
let geminiReply = null; // (req) => { status, body }

before(async () => {
  // Nachgebautes Gemini + Rezeptseiten
  mock = http.createServer(async (req, res) => {
    if (req.url.startsWith('/fixtures/')) {
      try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(await readFile(new URL('.' + req.url.slice(9), new URL('./fixtures/', import.meta.url)))); }
      catch { res.writeHead(404); res.end(); }
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    lastGeminiRequest = { url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
    const { status, body } = geminiReply(lastGeminiRequest);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  mockUrl = 'http://127.0.0.1:' + mock.address().port;
  const opts = { experimental: { disableExperimentalWarning: true }, logLevel: 'error' };
  worker = await unstable_dev('src/index.js', { ...opts, vars: { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: mockUrl, DEV: '1' } });
  workerNoKey = await unstable_dev('src/index.js', { ...opts, vars: { GEMINI_BASE_URL: mockUrl } });
});
after(async () => { await worker?.stop(); await workerNoKey?.stop(); mock?.close(); });

const answer = obj => () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
const scan = (w, task, body, origin = ORIGIN) => w.fetch('/scan/' + task, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body)
});
const bild = { data: PNG_1PX, mimeType: 'image/png' };

test('Status-Seite', async () => {
  const r = await worker.fetch('/');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j.aufgaben, ['rezept', 'prospekt', 'vokabeln']);
  assert.equal(j.bereit, true);
});

test('Rezept-Scan: Anfrage an Gemini korrekt aufgebaut, Ergebnis wird durchgereicht', async () => {
  const ergebnis = { titel: 'Kalter Hund', portionen: '', zutaten: [{ name: 'Kokosfett', menge: '250 g', hinweis: '', abschnitt: '' }] };
  geminiReply = answer(ergebnis);
  const r = await scan(worker, 'rezept', { bild, kontext: { abschnitte: ['Obst & Gemüse', 'Backwaren'], unbekannt: 'darf nicht ankommen' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(await r.json(), { aufgabe: 'rezept', ergebnis });

  const g = lastGeminiRequest;
  assert.match(g.url, /\/models\/gemini-flash-latest:generateContent$/);
  assert.equal(g.headers['x-goog-api-key'], 'test-key');
  const [img, prompt] = g.body.contents[0].parts;
  assert.deepEqual(img.inline_data, { mime_type: 'image/png', data: PNG_1PX });
  assert.match(prompt.text, /Zutaten dieses Rezepts/);
  assert.match(prompt.text, /abschnitte: Obst & Gemüse, Backwaren/);
  assert.doesNotMatch(prompt.text, /darf nicht ankommen/);
  assert.equal(g.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(g.body.generationConfig.responseSchema.properties.zutaten);
});

test('Vokabel- und Prospekt-Aufgabe nutzen ihr eigenes Format', async () => {
  geminiReply = answer({ sprache: 'en', lektion: 'Unit 1', vokabeln: [{ wort: 'to go', uebersetzung: 'gehen', lautschrift: 'gəʊ', beispiel: '', beispiel_de: '', wortart: 'Verb', zusatz: 'went, gone' }] });
  let r = await scan(worker, 'vokabeln', { bild, kontext: { sprache: 'en' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ergebnis.vokabeln[0].zusatz, 'went, gone');
  assert.ok(lastGeminiRequest.body.generationConfig.responseSchema.properties.vokabeln);
  assert.match(lastGeminiRequest.body.contents[0].parts[1].text, /sprache: en/);

  geminiReply = answer({ laden: 'Aldi', gueltig: '', angebote: [] });
  r = await scan(worker, 'prospekt', { bild });
  assert.equal(r.status, 200);
  assert.ok(lastGeminiRequest.body.generationConfig.responseSchema.properties.angebote);
});

test('Herkunft wird geprüft', async () => {
  assert.equal((await scan(worker, 'rezept', { bild }, 'https://fremd.example')).status, 403);
  assert.equal((await scan(worker, 'rezept', { bild }, null)).status, 403);
  // localhost nur mit DEV=1
  assert.equal((await scan(worker, 'rezept', { bild }, 'http://localhost:8080')).status, 200);
  assert.equal((await scan(workerNoKey, 'rezept', { bild }, 'http://localhost:8080')).status, 403);
});

test('Ungültige Anfragen', async () => {
  const code = async (res, status, error) => { assert.equal(res.status, status); assert.equal((await res.json()).error, error); };
  await code(await scan(worker, 'gibtsnicht', { bild }), 404, 'unknown_task');
  await code(await scan(worker, 'rezept', {}), 400, 'no_image');
  await code(await scan(worker, 'rezept', { bild: { data: PNG_1PX, mimeType: 'application/pdf' } }), 415, 'image_type');
  await code(await scan(worker, 'rezept', { bild: { data: 'A'.repeat(8_000_001), mimeType: 'image/jpeg' } }), 413, 'too_large');
  await code(await worker.fetch('/scan/rezept', { headers: { Origin: ORIGIN } }), 405, 'method');
  await code(await worker.fetch('/scan/rezept', { method: 'POST', headers: { Origin: ORIGIN }, body: 'kein json' }), 400, 'bad_request');
});

test('Gemini-Fehler werden verständlich weitergegeben', async () => {
  const code = async (res, status, error) => { assert.equal(res.status, status); assert.equal((await res.json()).error, error); };
  geminiReply = () => ({ status: 429, body: { error: { message: 'Resource exhausted' } } });
  await code(await scan(worker, 'rezept', { bild }), 429, 'quota');
  geminiReply = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: '{"titel": "abgebroch' }] } }] } });
  await code(await scan(worker, 'rezept', { bild }), 502, 'bad_response');
  geminiReply = () => ({ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } });
  await code(await scan(worker, 'rezept', { bild }), 422, 'blocked');
  geminiReply = () => ({ status: 503, body: {} });
  await code(await scan(worker, 'rezept', { bild }), 502, 'upstream');
  await code(await scan(workerNoKey, 'rezept', { bild }, ORIGIN), 500, 'not_configured');
});

test('Rezept-Link: JSON-LD, @graph, Microdata, keine Rezeptdaten', async () => {
  const get = async (page, path = '/rezept-link?url=') => {
    const r = await worker.fetch(path + encodeURIComponent(mockUrl + '/fixtures/' + page), { headers: { Origin: ORIGIN } });
    return { status: r.status, body: await r.json() };
  };
  let r = await get('chefkoch.html');
  assert.equal(r.body.name, 'Lasagne von Mama');
  assert.equal(r.body.yield, '4 Portionen');
  assert.ok(r.body.ingredients.includes('2 Zehe/n Knoblauch'));
  r = await get('wprm.html');
  assert.equal(r.body.name, 'Käsekuchen ohne Boden');
  assert.equal(r.body.yield, '12 Stücke');
  assert.ok(r.body.ingredients.includes('1 ½ TL Backpulver'));
  r = await get('microdata.html');
  assert.deepEqual(r.body.ingredients, ['250 g Mehl', '3 Eier', '500 ml Milch', '1 Prise Salz']);
  r = await get('nope.html');
  assert.deepEqual(r, { status: 404, body: { error: 'norecipe' } });
  // alte Adresse des Einkaufszettels: /?url=
  r = await get('chefkoch.html', '/?url=');
  assert.equal(r.body.name, 'Lasagne von Mama');
  const bad = await worker.fetch('/rezept-link?url=' + encodeURIComponent('file:///etc/passwd'), { headers: { Origin: ORIGIN } });
  assert.equal(bad.status, 400);
});

test('Fehlerdetails enthalten Modell und HTTP-Status', async () => {
  geminiReply = () => ({ status: 500, body: { error: { message: 'Internal error' } } });
  const r = await scan(worker, 'rezept', { bild });
  const j = await r.json();
  assert.equal(r.status, 502);
  assert.equal(j.error, 'upstream');
  assert.match(j.detail, /gemini-flash-latest: HTTP 500 Internal error/);
});

test('Überlastung: zweiter Versuch', async () => {
  let calls = 0;
  geminiReply = () => (++calls === 1 ? { status: 503, body: { error: { message: 'overloaded' } } } : answer({ titel: '', portionen: '', zutaten: [] })());
  const r = await scan(worker, 'rezept', { bild });
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
});

test('Diagnose-Seite', async () => {
  // Modellliste + erstes Modell unbekannt, zweites antwortet
  geminiReply = req => req.url.startsWith('/models?') ? { status: 200, body: { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] } }
    : /gemini-flash-latest/.test(req.url) ? { status: 404, body: { error: { message: 'not found' } } } : answer('OK')();
  let j = await (await worker.fetch('/diagnose')).json();
  assert.equal(j.ok, true);
  assert.equal(j.modell, 'gemini-2.5-flash');
  assert.deepEqual(j.schritte.map(s => [s.test, s.status]), [['Modellliste', 200], ['gemini-flash-latest', 404], ['gemini-2.5-flash', 200]]);
  assert.deepEqual(j.schritte[0].flash, ['gemini-2.5-flash']);
  assert.equal(typeof j.schritte[0].ms, 'number');

  geminiReply = () => ({ status: 403, body: { error: { message: 'API key not valid' } } });
  j = await (await worker.fetch('/diagnose')).json();
  assert.equal(j.ok, false);
  assert.equal(j.schritte[0].meldung, 'API key not valid');
  j = await (await workerNoKey.fetch('/diagnose')).json();
  assert.deepEqual([j.ok, j.error], [false, 'not_configured']);
});

test('Unbekanntes Modell: nächstes Modell wird probiert und gemerkt', async () => {
  const seen = [];
  geminiReply = req => {
    seen.push(req.url.match(/models\/([^:]+)/)[1]);
    return /gemini-flash-latest/.test(req.url)
      ? { status: 404, body: { error: { message: 'models/gemini-flash-latest is not found' } } }
      : answer({ titel: 'X', portionen: '', zutaten: [] })();
  };
  let r = await scan(worker, 'rezept', { bild });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['gemini-flash-latest', 'gemini-2.5-flash']);
  seen.length = 0;
  r = await scan(worker, 'rezept', { bild });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['gemini-2.5-flash']); // gemerkt
});
