/* Tests für den Worker: startet ihn lokal (wrangler unstable_dev) gegen einen nachgebauten Gemini-Server.
   Aufruf: npm test */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { unstable_dev } from 'wrangler';
import { newestFlashModels } from '../src/gemini.js';

const ORIGIN = 'https://mohnstollen.github.io';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let mock, mockUrl, worker, workerNoKey;
let lastGeminiRequest = null;
let geminiReply = null; // (req) => { status, body }
// Modellliste des nachgebauten Gemini (GET /models); listReply überschreibt die Antwort
const MODEL_LIST = ['gemini-3.8-flash-lite', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3.8-flash-image'];
let listReply = null;

before(async () => {
  // Nachgebautes Gemini + Rezeptseiten
  mock = http.createServer(async (req, res) => {
    if (req.url.startsWith('/fixtures/')) {
      try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(await readFile(new URL('.' + req.url.slice(9), new URL('./fixtures/', import.meta.url)))); }
      catch { res.writeHead(404); res.end(); }
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/models')) {
      const { status, body } = listReply ? listReply() : { status: 200, body: { models: MODEL_LIST.map(n => ({ name: 'models/' + n })) } };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
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
  assert.match(g.url, /\/models\/gemini-3\.8-flash:generateContent$/); // neuestes reguläres Flash-Modell
  assert.equal(g.headers['x-goog-api-key'], 'test-key');
  const [img, prompt] = g.body.contents[0].parts;
  assert.deepEqual(img.inline_data, { mime_type: 'image/png', data: PNG_1PX });
  assert.match(prompt.text, /Zutaten dieses Rezepts/);
  assert.match(prompt.text, /abschnitte: Obst & Gemüse, Backwaren/);
  assert.doesNotMatch(prompt.text, /darf nicht ankommen/);
  assert.equal(g.body.generationConfig.responseMimeType, 'application/json');
  const props = g.body.generationConfig.responseSchema.properties;
  assert.ok(props.zutaten);
  assert.ok(props.kategorie.enum.includes('Kuchen & Torten'));
  assert.ok(props.merkmale.items.enum.includes('Weihnachten'));
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
  geminiReply = () => ({ status: 503, body: { error: { message: 'This model is currently experiencing high demand.' } } });
  await code(await scan(worker, 'rezept', { bild }), 503, 'busy');
  geminiReply = () => ({ status: 502, body: {} });
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
  assert.equal(r.body.category, 'Hauptspeise');
  assert.equal(r.body.keywords, 'Pasta, Auflauf, Backen');
  r = await get('wprm.html');
  assert.equal(r.body.name, 'Käsekuchen ohne Boden');
  assert.equal(r.body.yield, '12 Stücke');
  assert.ok(r.body.ingredients.includes('1 ½ TL Backpulver'));
  assert.equal(r.body.category, 'Kuchen');
  assert.equal(r.body.keywords, 'Käsekuchen, ohne Boden');
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
  assert.match(j.detail, /HTTP 500 Internal error/);
});

test('Überlastung: sofort nächstes Modell', async () => {
  const seen = [];
  geminiReply = req => {
    const model = req.url.match(/models\/([^:]+)/)[1];
    seen.push(model);
    return /gemini-3\.8-flash$|gemini-3\.7-flash$/.test(model) ? { status: 503, body: { error: { message: 'high demand' } } } : answer({ titel: '', portionen: '', zutaten: [] })();
  };
  const r = await scan(worker, 'rezept', { bild });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.slice(-3), ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash']);
});

test('Diagnose-Seite', async () => {
  const seen = [];
  geminiReply = req => {
    seen.push(req.url);
    if (/countTokens/.test(req.url)) return { status: 200, body: { totalTokens: 7 } };
    if (/interactions/.test(req.url)) return { status: 400, body: { error: { message: 'Invalid JSON payload' } } };
    if (req.body.generationConfig?.thinkingConfig?.thinkingBudget === 0) return { status: 400, body: { error: { message: 'thinkingBudget is not supported' } } };
    return answer('OK')();
  };
  let j = await (await worker.fetch('/diagnose')).json();
  assert.equal(j.ok, true);
  assert.equal(j.modell, 'gemini-3.8-flash');
  assert.deepEqual(j.auswahl, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-3.8-flash-lite', 'gemini-flash-latest']);
  const by = Object.fromEntries(j.schritte.map(s => [s.test, s]));
  assert.deepEqual(by.Modellliste.flash, ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-2.5-flash']);
  assert.equal(by.generateContent.antwort, '"OK"');
  assert.equal(by['thinkingLevel low'].status, 200);
  assert.equal(by['thinkingBudget 0'].meldung, 'thinkingBudget is not supported');
  assert.equal(by.Streaming.status, 200);
  assert.equal(typeof by.Streaming.erste_daten_ms, 'number');
  assert.equal(by.countTokens.tokens, 7);
  assert.equal(by['Interactions API'].meldung, 'Invalid JSON payload');
  assert.ok(seen.some(u => /streamGenerateContent\?alt=sse/.test(u)));

  listReply = () => ({ status: 403, body: { error: { message: 'API key not valid' } } });
  geminiReply = () => ({ status: 403, body: { error: { message: 'API key not valid' } } });
  j = await (await worker.fetch('/diagnose')).json();
  listReply = null;
  assert.equal(j.ok, false);
  assert.equal(j.schritte[0].meldung, 'API key not valid');
  assert.deepEqual(j.auswahl, ['gemini-flash-latest']);
  j = await (await workerNoKey.fetch('/diagnose')).json();
  assert.deepEqual([j.ok, j.error], [false, 'not_configured']);
});

test('Unbekanntes Modell: nächstes Modell wird probiert und gemerkt', async () => {
  // der vorige Test hat gemini-2.5-flash als funktionierend gemerkt – jetzt ist es abgeschaltet
  const seen = [];
  geminiReply = req => {
    seen.push(req.url.match(/models\/([^:]+)/)[1]);
    return /gemini-2\.5-flash:/.test(req.url)
      ? { status: 404, body: { error: { message: 'models/gemini-2.5-flash is no longer available' } } }
      : answer({ titel: 'X', portionen: '', zutaten: [] })();
  };
  let r = await scan(worker, 'rezept', { bild });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['gemini-2.5-flash', 'gemini-3.8-flash']);
  seen.length = 0;
  r = await scan(worker, 'rezept', { bild });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['gemini-3.8-flash']); // gemerkt
});

test('Modellwahl: neueste reguläre Flash-Modelle zuerst', () => {
  assert.deepEqual(
    newestFlashModels(['gemini-3.8-flash', 'gemini-3.10-flash', 'gemini-3-flash', 'gemini-3.8-flash-lite', 'gemini-3.9-flash-preview', 'gemini-flash-latest', 'gemini-3.5-pro', 'gemini-4-flash-image']),
    ['gemini-3.10-flash', 'gemini-3.8-flash', 'gemini-3-flash']);
});
