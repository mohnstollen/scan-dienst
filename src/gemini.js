/* Aufruf der Gemini API (generateContent) mit Bild, Auftrag und vorgegebenem Antwortformat.
   https://ai.google.dev/api/generate-content */

export const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(code, status, detail) { super(code); this.code = code; this.status = status; this.detail = detail; }
}

/* → geparstes JSON gemäß task.format */
export async function askGemini(env, task, image, contextText) {
  if (!env.GEMINI_API_KEY) throw new GeminiError('not_configured', 500);
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const base = env.GEMINI_BASE_URL || DEFAULT_BASE; // nur für Tests überschreiben
  const body = {
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
  };

  let res;
  try {
    res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.GEMINI_TIMEOUT_MS) || 45_000)
    });
  } catch (e) {
    throw new GeminiError(e.name === 'TimeoutError' ? 'timeout' : 'upstream', 504);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    if (res.status === 429) throw new GeminiError('quota', 429, detail);
    if (res.status === 400) throw new GeminiError('bad_request', 400, detail);
    if (res.status === 401 || res.status === 403) throw new GeminiError('not_configured', 500, detail);
    throw new GeminiError('upstream', 502, detail);
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) throw new GeminiError('blocked', 422, JSON.stringify(data.promptFeedback || {}).slice(0, 300));
  const text = (cand.content && cand.content.parts || []).map(p => p.text || '').join('');
  try { return JSON.parse(text); } catch { throw new GeminiError('bad_response', 502, text.slice(0, 300)); }
}
