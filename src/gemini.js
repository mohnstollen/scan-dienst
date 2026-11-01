/* Aufruf der Gemini API (generateContent) mit Bild, Auftrag und vorgegebenem Antwortformat.
   https://ai.google.dev/api/generate-content */

// Reihenfolge der Modelle: das erste, das Gemini kennt, wird genutzt (Modellnamen ändern sich gelegentlich).
// Mit der Variablen GEMINI_MODEL lässt sich ein bestimmtes Modell vorgeben.
export const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];
export const DEFAULT_MODEL = MODELS[0];
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(code, status, detail) { super(code); this.code = code; this.status = status; this.detail = detail || ''; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let workingModel = null; // zuletzt erfolgreich genutztes Modell (je Worker-Instanz)

/* Ein generateContent-Aufruf; probiert bei unbekanntem Modell (404) das nächste, bei Überlastung (500/503) einmal erneut.
   → { model, data } */
async function generate(env, body) {
  if (!env.GEMINI_API_KEY) throw new GeminiError('not_configured', 500, 'GEMINI_API_KEY fehlt');
  const base = env.GEMINI_BASE_URL || DEFAULT_BASE; // nur für Tests überschreiben
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL] : workingModel ? [workingModel, ...MODELS.filter(m => m !== workingModel)] : MODELS;
  let last = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify(body),
          // dichte Prospektseiten können bei „denkenden“ Modellen eine Weile dauern
          signal: AbortSignal.timeout(Number(env.GEMINI_TIMEOUT_MS) || 90_000)
        });
      } catch (e) {
        throw new GeminiError(e.name === 'TimeoutError' ? 'timeout' : 'upstream', 504, `${model}: ${e.message}`);
      }
      if (res.ok) { workingModel = model; return { model, data: await res.json() }; }

      const detail = `${model}: HTTP ${res.status} ${await message(res)}`;
      if (res.status === 429) throw new GeminiError('quota', 429, detail);
      if (res.status === 400) throw new GeminiError('bad_request', 400, detail);
      if (res.status === 401 || res.status === 403) throw new GeminiError('not_configured', 500, detail);
      last = new GeminiError('upstream', 502, detail);
      if (res.status === 404) break;                 // Modell unbekannt → nächstes Modell
      if (attempt === 0 && res.status >= 500) { await sleep(800); continue; } // überlastet → einmal erneut
      throw last;
    }
  }
  throw last || new GeminiError('upstream', 502, 'kein Modell verfügbar');
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
   2. jedes Modell mit einer winzigen Textanfrage, bis eines antwortet */
export async function diagnose(env) {
  const base = env.GEMINI_BASE_URL || DEFAULT_BASE;
  const out = { ok: false, schluessel: !!env.GEMINI_API_KEY, schritte: [] };
  if (!env.GEMINI_API_KEY) return { ...out, error: 'not_configured', detail: 'GEMINI_API_KEY fehlt' };
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY };
  const step = async (name, run) => {
    const t0 = Date.now();
    try { const r = await run(); out.schritte.push({ test: name, ms: Date.now() - t0, ...r }); return r; }
    catch (e) { out.schritte.push({ test: name, ms: Date.now() - t0, fehler: e.message }); return null; }
  };

  await step('Modellliste', async () => {
    const res = await fetch(`${base}/models?pageSize=200`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { status: res.status, meldung: await message(res) };
    const names = ((await res.json()).models || []).map(m => String(m.name).replace(/^models\//, ''));
    return { status: res.status, flash: names.filter(n => /flash/.test(n)).slice(0, 20) };
  });
  for (const model of env.GEMINI_MODEL ? [env.GEMINI_MODEL] : MODELS) {
    const r = await step(model, async () => {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers, signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Antworte nur mit OK.' }] }] })
      });
      if (!res.ok) return { status: res.status, meldung: await message(res) };
      const data = await res.json();
      const text = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');
      return { status: res.status, antwort: text.slice(0, 40) };
    });
    if (r && r.status === 200) { out.ok = true; out.modell = model; break; }
  }
  return out;
}
