/* scan-client.js – Anbindung von Web-Apps an den Scan-Dienst (ohne Abhängigkeiten).
   Diese Datei in die App kopieren und als Modul laden:

     import { createScanner } from './scan-client.js';
     const scanner = createScanner({ endpoint: 'https://scan-dienst.<name>.workers.dev' });
     const { ergebnis } = await scanner.scan('rezept', datei, { kontext: { abschnitte: ['Obst', 'Backwaren'] } });
     const rezept = await scanner.rezeptLink('https://www.chefkoch.de/rezepte/…');

   Fehler kommen als ScanError mit .code (siehe ERROR_TEXT) und einer deutschen Meldung in .message. */

export const ERROR_TEXT = {
  offline: 'Keine Internetverbindung.',
  timeout: 'Die Erkennung hat zu lange gedauert – bitte erneut versuchen.',
  quota: 'Das Tageslimit für die Erkennung ist erreicht – bitte später erneut versuchen.',
  rate_limit: 'Zu viele Scans in kurzer Zeit – bitte etwas warten.',
  too_large: 'Das Bild ist zu groß.',
  image_type: 'Dieses Bildformat wird nicht unterstützt.',
  no_image: 'Kein Bild übergeben.',
  origin: 'Diese App ist für den Scan-Dienst nicht freigeschaltet.',
  not_configured: 'Der Scan-Dienst ist noch nicht vollständig eingerichtet.',
  unknown_task: 'Diese Scan-Art gibt es nicht.',
  blocked: 'Das Bild konnte nicht verarbeitet werden.',
  bad_request: 'Das Bild konnte nicht verarbeitet werden.',
  bad_response: 'Die Antwort der Erkennung war unvollständig – bitte erneut versuchen.',
  upstream: 'Gemini meldet einen Fehler – bitte später erneut versuchen.',
  network: 'Der Scan-Dienst ist nicht erreichbar.',
  internal: 'Im Scan-Dienst ist ein Fehler aufgetreten.',
  norecipe: 'Auf dieser Seite wurde kein Rezept gefunden.',
  fetch: 'Die Seite konnte nicht geladen werden.',
  status: 'Die Seite konnte nicht geladen werden.',
  url: 'Das ist keine gültige Adresse.',
  aborted: 'Abgebrochen.',
  unknown: 'Unbekannter Fehler.'
};

/* .code: Fehlercode, .status: HTTP-Status, .detail: technische Angabe des Dienstes (z. B. „gemini-flash-latest: HTTP 404 …“) */
export class ScanError extends Error {
  constructor(code, status, detail) {
    super(ERROR_TEXT[code] || ERROR_TEXT.unknown);
    this.code = code; this.status = status; this.detail = detail || '';
  }
  /* kurze Kennung für Fehlermeldungen, z. B. „upstream 404“ */
  get kennung() {
    const http = (this.detail.match(/HTTP (\d{3})/) || [])[1];
    return [this.code, http].filter(Boolean).join(' ');
  }
}

/* Bild für den Versand vorbereiten: richtig gedreht, längste Seite höchstens maxSize, JPEG.
   Verkleinert große Handyfotos (oft 5–10 MB) auf wenige hundert KB – schneller und ausreichend scharf. */
export async function prepareImage(file, { maxSize = 2000, quality = 0.85 } = {}) {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const f = Math.min(1, maxSize / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * f);
  canvas.height = Math.round(img.height * f);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparente PNGs (Screenshots) nicht schwarz werden lassen
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close && img.close();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  return { data: String(dataUrl).split(',')[1], mimeType: 'image/jpeg', width: canvas.width, height: canvas.height, bytes: blob.size };
}

export function createScanner({ endpoint, maxSize, quality } = {}) {
  const base = String(endpoint || '').replace(/\/+$/, '');
  if (!base) throw new Error('createScanner: endpoint fehlt');

  async function call(path, init, signal) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ScanError('offline');
    let res;
    try { res = await fetch(base + path, { ...init, signal }); }
    catch (e) { throw new ScanError(e.name === 'AbortError' ? 'aborted' : (navigator.onLine === false ? 'offline' : 'network'), 0, e.message); }
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok || !body) throw new ScanError((body && body.error) || 'unknown', res.status, (body && body.detail) || 'HTTP ' + res.status);
    return body;
  }

  return {
    /* Bild (File/Blob) mit einer Aufgabe des Scan-Dienstes auswerten → { aufgabe, ergebnis }
       onStatus('bild' | 'senden') für eine Fortschrittsanzeige */
    async scan(aufgabe, file, { kontext, signal, onStatus } = {}) {
      onStatus && onStatus('bild');
      const bild = await prepareImage(file, { maxSize, quality });
      onStatus && onStatus('senden');
      return call('/scan/' + encodeURIComponent(aufgabe), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bild: { data: bild.data, mimeType: bild.mimeType }, kontext })
      }, signal);
    },

    /* Rezept einer Webseite (schema.org/Recipe) → { name, ingredients, yield, url } */
    rezeptLink(url, { signal } = {}) {
      return call('/rezept-link?url=' + encodeURIComponent(url), {}, signal);
    },

    /* Verfügbare Aufgaben → { rezept: { beschreibung, kontext }, … } */
    aufgaben({ signal } = {}) { return call('/aufgaben', {}, signal); }
  };
}
