/* Aufgaben des Scan-Dienstes.
   Jede Aufgabe legt fest, was Gemini mit dem Bild tun soll (auftrag), in welcher Form die Antwort kommt
   (format, OpenAPI-Teilmenge wie von Gemini erwartet) und welche Apps sie nutzen dürfen (apps).
   Neue Aufgabe = neuer Eintrag hier, sonst ist nichts zu ändern.

   kontext: Angaben, die eine App mitschicken darf (z. B. die Abschnitte ihrer Einkaufsliste).
   Nur die hier genannten Felder werden übernommen und als Text an den Auftrag angehängt. */

const S = { type: 'STRING' };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'OBJECT', properties, required });
const list = items => ({ type: 'ARRAY', items });

const EIGENE_APPS = ['https://mohnstollen.github.io'];

// Rezept-Kategorien und -Merkmale wie im Einkaufszettel (dort in app.js: RECIPE_CATEGORIES, RECIPE_TAGS)
const KATEGORIEN = ['Frühstück', 'Vorspeise', 'Suppe', 'Salat', 'Hauptgericht', 'Beilage', 'Dessert',
  'Kuchen & Torten', 'Gebäck & Plätzchen', 'Brot & Brötchen', 'Snack', 'Getränk', 'Sonstiges'];
const MERKMALE = ['Frühling', 'Sommer', 'Herbst', 'Winter', 'Weihnachten', 'Ostern', 'Grillen', 'vegetarisch', 'vegan', 'schnell'];

export const TASKS = {
  rezept: {
    beschreibung: 'Zutatenliste aus Rezeptfoto oder Screenshot',
    apps: EIGENE_APPS,
    kontext: { abschnitte: 'Abschnitte der Einkaufsliste – ordne jede Zutat einem davon zu (Feld „abschnitt“), sonst leer lassen' },
    auftrag: `Du erhältst ein Foto oder einen Screenshot, auf dem ein Rezept zu sehen ist (Kochbuch, Zeitschrift, Webseite, App).
Lies ausschließlich die Zutaten dieses Rezepts aus.
- Ignoriere alles andere: Menüs, Buttons, Werbung, Bewertungen, Zubereitungstext, angeschnittene Nachbarspalten.
- Zwischenüberschriften wie „Für den Teig“ sind keine Zutaten.
- name: die Zutat als kurzer, allgemeiner Einkaufsbegriff im Singular oder in der üblichen Einkaufsform
  („Butter“ statt „weiche Butter“, „Eier“, „Zwiebel“, „Knoblauch“). Zustände oder Verarbeitungen
  („gehackt“, „zimmerwarm“, „Type 405“) gehören in „hinweis“.
- menge: Menge mit Einheit in üblicher Schreibweise („200 g“, „2 EL“, „1 Prise“, „1 Pck.“, „2–3“); leer, wenn keine.
  Alte Schreibweisen umwandeln („Eßl.“ → „EL“, „Teel.“ → „TL“).
- Steht eine Zutat mehrfach (z. B. in Teig und Füllung), führe sie mehrfach auf.
- kategorie: die passendste Kategorie für das Gericht.
- merkmale: nur zutreffende – Jahreszeit oder Anlass, wenn das Gericht typisch dafür ist; „vegetarisch“/„vegan“ nur,
  wenn das aus den Zutaten eindeutig folgt; „schnell“ bei höchstens etwa 30 Minuten Zubereitung.
- Ist kein Rezept zu erkennen, gib eine leere Zutatenliste zurück. Erfinde nichts.`,
    format: obj({
      titel: S,
      portionen: S,
      kategorie: { type: 'STRING', enum: KATEGORIEN },
      merkmale: list({ type: 'STRING', enum: MERKMALE }),
      zutaten: list(obj({ name: S, menge: S, hinweis: S, abschnitt: S }))
    })
  },

  prospekt: {
    beschreibung: 'Angebote aus einer Prospektseite',
    apps: EIGENE_APPS,
    kontext: { abschnitte: 'Abschnitte der Einkaufsliste – ordne jedes Angebot einem davon zu (Feld „abschnitt“), sonst leer lassen' },
    auftrag: `Du erhältst das Foto einer Seite aus einem Werbeprospekt eines Supermarkts, Discounters, einer Drogerie oder eines Baumarkts.
Lies alle Angebote (Produkte mit Preis) aus.
- name: allgemeiner Einkaufsbegriff ohne Marke („Milch“, „Hähnchenbrust“, „Spülmaschinentabs“, „Akkuschrauber“).
- produkt: Marke und genaue Bezeichnung, wie im Prospekt („Milsani H-Milch 1,5 %“).
- menge: Packungsgröße („1 l“, „500 g“, „40 Stück“), leer wenn nicht angegeben.
- preis: Angebotspreis mit Währung („0,89 €“). grundpreis: falls angegeben („1 kg = 9,98 €“).
- hinweis: Besonderheiten wie „App-Preis“, „ab Donnerstag“, „Aktion 2 für 1“, sonst leer.
- laden: Name des Geschäfts, falls erkennbar. gueltig: Gültigkeitszeitraum, falls erkennbar.
- Ignoriere reine Werbetexte ohne Produkt und Preis. Erfinde keine Angebote.`,
    format: obj({
      laden: S,
      gueltig: S,
      angebote: list(obj({ name: S, produkt: S, menge: S, preis: S, grundpreis: S, hinweis: S, abschnitt: S }))
    })
  },

  vokabeln: {
    beschreibung: 'Vokabelliste aus einem Lehr- oder Schulbuch (Englisch/Französisch – Deutsch)',
    apps: EIGENE_APPS,
    kontext: { sprache: 'Erwartete Fremdsprache als Sprachcode, z. B. „en“ oder „fr“' },
    auftrag: `Du erhältst das Foto einer Vokabelseite aus einem Lehr- oder Schulbuch (Fremdsprache – Deutsch, meist in Spalten:
Wort | Beispielsatz | Übersetzung).
Lies alle Vokabeln in der Reihenfolge der Seite aus.
- wort: das fremdsprachige Wort oder die Wendung genau wie gedruckt. Bei Französisch den Artikel mitnehmen
  („la maison“, „l'école (f)“), bei englischen Verben „to“ beibehalten, wenn es dasteht.
- uebersetzung: die deutsche Bedeutung wie gedruckt (mehrere Bedeutungen mit Komma).
- lautschrift: Lautschrift, falls gedruckt (ohne eckige Klammern), sonst leer.
- beispiel: Beispielsatz in der Fremdsprache, falls vorhanden; beispiel_de: dessen Übersetzung, falls vorhanden.
- wortart: falls erkennbar („Verb“, „Nomen“, „Adjektiv“, „Wendung“ …), sonst leer.
- zusatz: Formen und Hinweise wie Genus, Plural, unregelmäßige Formen („went, gone“; „pl. children“; „m“), sonst leer.
- sprache: Sprachcode der Fremdsprache („en“, „fr“ …). lektion: Überschrift der Lektion/Unit, falls erkennbar.
- Ignoriere Seitenzahlen, Kopfzeilen und Übungen. Erfinde nichts; unleserliche Einträge weglassen.`,
    format: obj({
      sprache: S,
      lektion: S,
      vokabeln: list(obj({ wort: S, uebersetzung: S, lautschrift: S, beispiel: S, beispiel_de: S, wortart: S, zusatz: S }))
    })
  }
};
