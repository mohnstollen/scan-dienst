# scan-dienst

Fotos per [Gemini](https://ai.google.dev/) in strukturierte Daten umwandeln – als wiederverwendbarer Baustein
für mehrere Web-Apps (Einkaufszettel, Vokabeltrainer, …).

```
App ──(Foto)──▶ client/scan-client.js ──▶ Cloudflare Worker ──▶ Gemini
App ◀──── fertiges JSON (z. B. Zutaten, Angebote, Vokabeln) ────┘
```

- **Worker** (`src/`): kennt die Aufgaben, prüft, welche App sie nutzen darf, und hält den Gemini-Schlüssel geheim.
- **Client** (`client/scan-client.js`): eine Datei ohne Abhängigkeiten zum Kopieren in die App – verkleinert das
  Foto, schickt es ab und liefert das Ergebnis oder einen verständlichen Fehler.

## Aufgaben

Definiert in [`src/tasks.js`](src/tasks.js). Jede Aufgabe besteht aus einem Auftrag an Gemini, dem Antwortformat
und der Liste der Apps (Herkunft), die sie nutzen dürfen.

| Aufgabe | Ergebnis |
|---|---|
| `rezept` | `{ titel, portionen, zutaten: [{ name, menge, hinweis, abschnitt }] }` |
| `prospekt` | `{ laden, gueltig, angebote: [{ name, produkt, menge, preis, grundpreis, hinweis, abschnitt }] }` |
| `vokabeln` | `{ sprache, lektion, vokabeln: [{ wort, uebersetzung, lautschrift, beispiel, beispiel_de, wortart, zusatz }] }` |

Apps können je Aufgabe festgelegte Zusatzangaben (`kontext`) mitschicken, z. B. die Abschnitte ihrer
Einkaufsliste, damit Gemini die Produkte gleich zuordnet. Andere Angaben werden ignoriert – Apps können also
keine eigenen Aufträge an Gemini schicken.

**Neue Aufgabe:** Eintrag in `src/tasks.js` ergänzen (Auftrag, Format, Apps), Test ergänzen, pushen. Fertig.

## Schnittstelle

| Aufruf | Antwort |
|---|---|
| `POST /scan/<aufgabe>` mit `{ bild: { data: <Base64>, mimeType }, kontext }` | `{ aufgabe, ergebnis }` |
| `GET /rezept-link?url=<Rezeptseite>` | `{ name, ingredients, yield, url }` (schema.org/Recipe der Seite, ohne KI) |
| `GET /aufgaben` | Aufgaben mit Beschreibung und erlaubtem Kontext |
| `GET /` | Status, z. B. `{ "bereit": true }` |

Fehler kommen als `{ "error": "<code>" }`: `origin`, `unknown_task`, `no_image`, `image_type`, `too_large`,
`rate_limit`, `quota` (Tageslimit von Gemini), `timeout`, `bad_response`, `blocked`, `upstream`,
`not_configured`, bei Rezept-Links `url`, `fetch`, `status`, `norecipe`. Der Client übersetzt sie in deutsche
Meldungen (`ERROR_TEXT`).

## In einer App verwenden

`client/scan-client.js` in die App kopieren:

```js
import { createScanner } from './scan-client.js';
const scanner = createScanner({ endpoint: 'https://scan-dienst.<name>.workers.dev' });

try {
  const { ergebnis } = await scanner.scan('rezept', foto, {
    kontext: { abschnitte: ['Obst & Gemüse', 'Backwaren'] },
    onStatus: s => console.log(s) // 'bild' (wird vorbereitet), 'senden'
  });
} catch (e) {
  alert(e.message); // z. B. „Keine Internetverbindung.“ – Code in e.code
}
```

Die Herkunft der App (z. B. `https://mohnstollen.github.io`) muss bei der Aufgabe unter `apps` stehen.

## Einrichtung

### 1. Gemini-Schlüssel
1. <https://aistudio.google.com/apikey> → **API-Schlüssel erstellen** (am besten in einem neuen Projekt).
2. Für das Projekt **keine Abrechnung** aktivieren – dann bleibt es beim kostenlosen Kontingent, und es können
   keine Kosten entstehen. Ist das Tageslimit erreicht, meldet der Dienst `quota`.

### 2. Worker bei Cloudflare bereitstellen
Der Worker besteht aus mehreren Dateien und wird deshalb aus diesem Repository bereitgestellt (nicht per
Kopieren im Code-Editor):

- **Mit Git-Anbindung (empfohlen):** Cloudflare-Dashboard → **Workers & Pages → Erstellen → Repository importieren**
  → GitHub verbinden → `scan-dienst` auswählen. Projektname `scan-dienst`, Build-Befehl leer lassen,
  Bereitstellungsbefehl `npx wrangler deploy`. Danach wird jeder Push auf `main` automatisch bereitgestellt.
- **Oder per Kommandozeile:** `npm install`, `npx wrangler login`, `npx wrangler deploy`.

### 3. Schlüssel hinterlegen
Worker `scan-dienst` → **Einstellungen → Variablen und Geheimnisse → Hinzufügen** → Typ **Geheimnis**,
Name `GEMINI_API_KEY`, Wert: der Schlüssel aus Schritt 1 → **Bereitstellen**.
(Kommandozeile: `npx wrangler secret put GEMINI_API_KEY`.)

Optional als Variable `GEMINI_MODEL`, Standard ist `gemini-flash-latest` (immer das aktuelle Flash-Modell).

### 4. Prüfen
`https://scan-dienst.<name>.workers.dev/` im Browser öffnen – erwartet: `"bereit": true`.

## Entwicklung

```sh
npm install
npm test        # Worker-Tests gegen einen nachgebauten Gemini-Server, ohne Schlüssel
npm run dev     # lokal starten; vorher .dev.vars.example nach .dev.vars kopieren
```

Läuft die Umgebung hinter einem HTTP-Proxy, die Tests ohne Proxy starten
(`env -u HTTPS_PROXY -u https_proxy npm test`) – sie brauchen kein Internet.

## Hinweise

- **Kosten:** Ohne Abrechnung im Google-Projekt nur das kostenlose Kontingent. Cloudflare Workers sind bis
  100.000 Aufrufe pro Tag kostenlos.
- **Datenschutz:** Im kostenlosen Tarif darf Google die übermittelten Bilder zur Verbesserung seiner Dienste
  verwenden. Keine Fotos mit persönlichen Daten scannen.
- **Nutzungsbedingungen:** Die Zusatzbedingungen der Gemini API schließen u. a. Anwendungen für Minderjährige aus
  – vor neuen Einsatzzwecken die aktuellen Bedingungen prüfen.
- **Missbrauchsschutz:** Herkunftsprüfung je Aufgabe, feste Aufträge, Bildgröße begrenzt, grobe Begrenzung auf
  60 Scans pro IP und Stunde.
