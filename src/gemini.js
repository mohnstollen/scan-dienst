/* Aufruf der Gemini API (generateContent) mit Bild, Auftrag und vorgegebenem Antwortformat.
   https://ai.google.dev/api/generate-content */

// Modellwahl: Ohne die Variable GEMINI_MODEL nimmt der Worker die neuesten regulären Flash-Modelle aus der
// Modellliste von Gemini (z. B. gemini-3.8-flash; nicht -lite, -preview, -image, -tts). Google stellt ältere
// Modelle laufend ab – so bleibt der Dienst ohne Codeänderung aktuell. Ist ein Modell überlastet („high demand“)
// oder antwortet nicht, kommt sofort das nächste dran (siehe candidatesFrom).
const FALLBACK_MODEL = 'gemini-flash-latest';
const MODEL_LIST_MS = 6 * 60 * 60 * 1000; // Modellliste alle 6 Stunden neu abfragen
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(code, status, detail) { super(code); this.code = code; this.status = status; this.detail = detail || ''; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let workingModel = null; // zuletzt erfolgreich genutztes Modell (je Worker-Instanz)
let modelCache = null;   // { at, models }
export const currentModel = env => env.GEMINI_MODEL || workingModel || 'automatisch';

/* Reguläre Flash-Modelle (bzw. Flash-Lite), neueste Version zuerst (gemini-3.10-flash vor gemini-3.8-flash) */
export function newestFlashModels(names, kind = 'flash') {
  const re = new RegExp('^gemini-(\\d+(?:\\.\\d+)*)-' + kind + '$');
  const version = n => (String(n).match(re) || [])[1];
  const newer = (a, b) => {
    const x = version(a).split('.').map(Number), y = version(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  };
  return names.filter(version).sort(newer);
}

async function listModels(env, base) {
  const res = await fetch(`${base}/models?pageSize=200`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new GeminiError(res.status === 401 || res.status === 403 ? 'not_configured' : 'upstream', res.status, `Modellliste: HTTP ${res.status} ${await message(res)}`);
  return ((await res.json()).models || []).map(m => String(m.name).replace(/^models\//, ''));
}
/* Reihenfolge der Versuche: drei neueste reguläre Flash-Modelle, dann das neueste Flash-Lite (meist mehr Kapazität),
   zuletzt gemini-flash-latest */
const candidatesFrom = names => [...new Set([
  ...newestFlashModels(names).slice(0, 3),
  ...newestFlashModels(names, 'flash-lite').slice(0, 1),
  FALLBACK_MODEL
])];

async function candidateModels(env, base) {
  if (env.GEMINI_MODEL) return [env.GEMINI_MODEL];
  if (!modelCache || Date.now() - modelCache.at > MODEL_LIST_MS) {
    let names = [];
    try { names = await listModels(env, base); } catch (e) { console.log('Modellliste nicht abrufbar', e.detail || e.message); }
    // ohne Liste nur kurz merken, damit der nächste Aufruf es erneut versucht
    modelCache = { at: names.length ? Date.now() : Date.now() - MODEL_LIST_MS + 60_000, models: candidatesFrom(names) };
  }
  return modelCache.models;
}

/* Ein generateContent-Aufruf; probiert bei unbekanntem Modell (404) das nächste, bei Überlastung (500/503) einmal erneut.
   → { model, data } */
async function generate(env, body) {
  if (!env.GEMINI_API_KEY) throw new GeminiError('not_configured', 500, 'GEMINI_API_KEY fehlt');
  const base = env.GEMINI_BASE_URL || DEFAULT_BASE; // nur für Tests überschreiben
  const candidates = await candidateModels(env, base);
  const models = workingModel && candidates.includes(workingModel) ? [workingModel, ...candidates.filter(m => m !== workingModel)] : candidates;
  // Gesamtbudget für alle Versuche; je Modell höchstens PER_MODEL_MS (bei Überlastung hält Gemini Anfragen oft lange fest)
  const deadline = Date.now() + (Number(env.GEMINI_TIMEOUT_MS) || 90_000);
  const PER_MODEL_MS = 35_000;
  let last = null, busy = false;
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < 5_000) break;
    let res;
    try {
      res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(remaining, PER_MODEL_MS))
      });
    } catch (e) {
      if (e.name !== 'TimeoutError') throw new GeminiError('upstream', 502, `${model}: ${e.message}`);
      busy = true; last = new GeminiError('timeout', 504, `${model}: keine Antwort`); continue; // nächstes Modell
    }
    if (res.ok) { workingModel = model; return { model, data: await res.json() }; }

    const detail = `${model}: HTTP ${res.status} ${await message(res)}`;
    if (res.status === 429) throw new GeminiError('quota', 429, detail);
    if (res.status === 400) throw new GeminiError('bad_request', 400, detail);
    if (res.status === 401 || res.status === 403) throw new GeminiError('not_configured', 500, detail);
    if (res.status === 503) { busy = true; last = new GeminiError('busy', 503, detail); continue; } // „high demand“ → nächstes Modell
    last = new GeminiError('upstream', 502, detail);
    if (res.status === 404 || res.status >= 500) continue; // Modell unbekannt bzw. Störung → nächstes Modell
    throw last;
  }
  if (busy) throw new GeminiError('busy', 503, last ? last.detail : 'überlastet');
  throw last || new GeminiError('timeout', 504, 'Zeitlimit erreicht');
}

async function message(res) {
  const text = await res.text();
  try { return (JSON.parse(text).error || {}).message || text.slice(0, 200); } catch { return text.slice(0, 200); }
}

/* Bild + Auftrag → geparstes JSON gemäß task.format */
export async function askGemini(env, task, image, contextText) {
  const { data } = await generate(env, {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: image.mimeType, data: image.data } },
        { text: task.auftrag + (contextText ? '\n\nZusätzliche Angaben der App:\n' + contextText : '') }
      ]
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: task.format
    }
  });
  const cand = data.candidates && data.candidates[0];
  if (!cand) throw new GeminiError('blocked', 422, JSON.stringify(data.promptFeedback || {}).slice(0, 300));
  const text = (cand.content && cand.content.parts || []).map(p => p.text || '').join('');
  try { return JSON.parse(text); } catch { throw new GeminiError('bad_response', 502, `finishReason ${cand.finishReason || '?'}: ${text.slice(0, 200)}`); }
}

/* Diagnose Schritt für Schritt (mit Zeitmessung):
   1. Modellliste abrufen – ist Gemini erreichbar, gilt der Schlüssel, welche Flash-Modelle gibt es?
   2. Für das bevorzugte Modell gleichzeitig mehrere Varianten (je max. 25 s):
      generateContent normal, mit wenig „Nachdenken“ (thinkingLevel low / thinkingBudget 0), Streaming
      (Zeit bis zu den ersten Daten), countTokens (ohne Erzeugung) und die neuere Interactions API. */
export async function diagnose(env) {
  const base = env.GEMINI_BASE_URL || DEFAULT_BASE;
  const out = { ok: false, schluessel: !!env.GEMINI_API_KEY, schritte: [] };
  if (!env.GEMINI_API_KEY) return { ...out, error: 'not_configured', detail: 'GEMINI_API_KEY fehlt' };
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY };
  const step = async (name, run) => {
    const t0 = Date.now();
    let r;
    try { r = { test: name, ...(await run(t0)) }; } catch (e) { r = { test: name, fehler: e.message }; }
    r.ms = Date.now() - t0;
    return r;
  };
  // Antworttext kurz zusammenfassen: Kandidatentext, Fehlermeldung, Tokenzahl oder Rohtext
  const summary = text => {
    try {
      const j = JSON.parse(text);
      const cand = (j.candidates || [])[0];
      if (cand) return { antwort: (cand.content?.parts || []).map(p => p.text || '').join('').slice(0, 60), ende: cand.finishReason, tokens: j.usageMetadata };
      if (j.error) return { meldung: String(j.error.message).slice(0, 300) };
      if (j.totalTokens != null) return { tokens: j.totalTokens };
    } catch {}
    return { roh: text.slice(0, 200) };
  };
  const call = (path, body, { stream } = {}) => async t0 => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
    const kopf_ms = Date.now() - t0;
    if (stream && res.ok) {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      reader.cancel().catch(() => {});
      return { status: res.status, kopf_ms, erste_daten_ms: Date.now() - t0, anfang: new TextDecoder().decode(value || new Uint8Array()).slice(0, 160) };
    }
    return { status: res.status, kopf_ms, ...summary(await res.text()) };
  };

  let names = [];
  out.schritte.push(await step('Modellliste', async () => {
    const res = await fetch(`${base}/models?pageSize=200`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { status: res.status, meldung: await message(res) };
    names = ((await res.json()).models || []).map(m => String(m.name).replace(/^models\//, ''));
    return { status: res.status, flash: names.filter(n => /^gemini-[\d.]+-flash$/.test(n)) };
  }));
  out.auswahl = env.GEMINI_MODEL ? [env.GEMINI_MODEL] : candidatesFrom(names);
  const model = out.modell = out.auswahl[0];
  const m = `/models/${encodeURIComponent(model)}`;
  const contents = [{ role: 'user', parts: [{ text: 'Antworte nur mit OK.' }] }];
  const tests = await Promise.all([
    step('generateContent', call(m + ':generateContent', { contents })),
    step('thinkingLevel low', call(m + ':generateContent', { contents, generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } })),
    step('thinkingBudget 0', call(m + ':generateContent', { contents, generationConfig: { thinkingConfig: { thinkingBudget: 0 } } })),
    step('Streaming', call(m + ':streamGenerateContent?alt=sse', { contents }, { stream: true })),
    step('countTokens', call(m + ':countTokens', { contents })),
    step('Interactions API', call('/interactions', { model, input: 'Antworte nur mit OK.' }))
  ]);
  out.schritte.push(...tests);
  out.ok = tests.slice(0, 3).some(t => t.status === 200 && t.antwort);
  return out;
}
