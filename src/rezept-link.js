/* Rezept einer Webseite auslesen (schema.org/Recipe aus JSON-LD, ersatzweise Microdata).
   Gibt nur Titel, Portionen und Zutaten zurück, nie die Seite selbst – taugt also nicht als offener Proxy. */

const MAX_BYTES = 4_000_000;
const TIMEOUT_MS = 10_000;

/* → { status, body } */
export async function recipeFromLink(urlParam) {
  let target;
  try { target = new URL(urlParam); } catch { return { status: 400, body: { error: 'url' } }; }
  if (!/^https?:$/.test(target.protocol)) return { status: 400, body: { error: 'url' } };

  let res;
  try {
    res = await fetch(target.href, {
      headers: {
        // wie ein normaler Handy-Browser – manche Seiten liefern Bots sonst nichts aus
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch { return { status: 502, body: { error: 'fetch' } }; }
  if (!res.ok) return { status: 502, body: { error: 'status', status: res.status } };

  const recipe = extractRecipe(await readText(res, MAX_BYTES));
  if (!recipe) return { status: 404, body: { error: 'norecipe' } };
  return { status: 200, body: { ...recipe, url: res.url || target.href } };
}

/* Seite lesen, aber höchstens maxBytes (Schutz vor riesigen Antworten) */
async function readText(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) { all.set(c.subarray(0, Math.min(c.length, size - pos)), pos); pos += c.length; }
  return new TextDecoder().decode(all);
}

export function extractRecipe(html) {
  // 1. JSON-LD (Chefkoch, WordPress-Rezeptplugins, die meisten großen Seiten)
  const scripts = html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    const recipe = findRecipe(parseJson(m[1]));
    const out = recipe && normalize(recipe);
    if (out) return out;
  }
  // 2. Microdata (itemprop="recipeIngredient")
  return microdata(html);
}

function parseJson(text) {
  const t = text.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
  try { return JSON.parse(t); } catch {}
  try { return JSON.parse(t.replace(/[\u0000-\u001f]+/g, ' ')); } catch {} // Zeilenumbrüche in Strings
  return null;
}

/* Rezept-Objekt in beliebig verschachteltem JSON-LD finden (@graph, Arrays, mainEntity …) */
function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; }
    return null;
  }
  const types = [].concat(node['@type'] || []).map(String);
  if (types.some(t => /(^|[/:])recipe$/i.test(t))) return node;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'hasPart']) {
    const r = findRecipe(node[k], depth + 1);
    if (r) return r;
  }
  return null;
}

function normalize(r) {
  const ingredients = [].concat(r.recipeIngredient || r.ingredients || []).map(text).filter(Boolean);
  if (!ingredients.length) return null;
  // „recipeYield“ ist mal „4“, mal „4 Portionen“, mal beides – die Angabe mit Einheit bevorzugen
  const yields = [].concat(r.recipeYield || []).map(text).filter(Boolean);
  const yld = yields.find(y => /[a-zäöü]/i.test(y)) || (yields[0] ? yields[0] + ' Portionen' : '');
  // Kategorie und Schlagwörter der Seite – die App leitet daraus ihre Rezept-Kategorie ab
  const category = [].concat(r.recipeCategory || []).map(text).filter(Boolean).join(', ');
  const keywords = [].concat(r.keywords || []).map(text).filter(Boolean).join(', ').slice(0, 300);
  return { name: text(r.name || r.headline), ingredients, yield: yld, category, keywords };
}

function microdata(html) {
  const ingredients = [];
  const re = /<([a-z0-9]+)\b[^>]*itemprop\s*=\s*["'](?:recipeIngredient|ingredients)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of html.matchAll(re)) { const t = text(m[2]); if (t) ingredients.push(t); }
  if (!ingredients.length) return null;
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const og = html.match(/<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  return { name: text(h1 ? h1[1] : og ? og[1] : ''), ingredients, yield: '', category: '', keywords: '' };
}

/* HTML-Tags entfernen, Entities auflösen, Leerraum zusammenfassen */
function text(v) {
  if (v == null) return '';
  if (typeof v === 'object') v = v.text || v.name || v['@value'] || '';
  return decodeEntities(String(v).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : named[e] ?? m);
}
