# Torrek Scan

> ⛔ **Abgrenzung — verbindlich.** Torrek Scan ist ein **eigenständiges Projekt**. Die
> bestehende **DryTrack/Torrek-Anwendung** — Code im Monorepo (`src/`, `hosting/`, `e2e/`,
> `CLAUDE.md`, `UEBERBLICK.md` …) **und** die Notion-Doku „DryTrack — Docs" — wird durch
> dieses Projekt **niemals verändert, kopiert-verändert oder entfernt**. Sämtliche
> Torrek-Scan-Arbeit lebt ausschließlich in `torrek-scan/` und in der Notion-Seite
> „Torrek-Scan.Doc". Wer hier mitarbeitet (Mensch oder KI): DryTrack ist tabu.

Eigenständige, **offline-first** Erfassungs-App für **Bautrocknungs-Geräte**: Der Monteur
scannt vor Ort per Handy-Kamera die Geräte-Barcodes, tippt den **Zählerstand (kWh)** ein und
hängt optional ein **Foto vom Zähler** an. Beim Abbau rechnet die App automatisch die
**Differenz** (Verbrauch) gegen den Aufbau-Stand und erzeugt eine **Excel-Liste fürs Büro**.

> Torrek Scan ist ein **separates Projekt** neben der Torrek/DryTrack-Hauptanwendung und
> speichert getrennt von ihr (eigene Supabase Edge Function). Produktdoku liegt in Notion
> unter **„Torrek-Scan.Doc"**.

## Was es kann

- **Barcode-Scan, speicherarm:** zuerst der **native `BarcodeDetector`** des Browsers (Android
  Chrome — hardwarenah, liest direkt vom Video, robust bei gewölbten/glänzenden Etiketten);
  ZXing nur als Ersatz, dann direkt vom Canvas. Mehrere 1D-Formate (Code 128/39/93, ITF,
  Codabar, EAN, UPC). Zusätzlich: **Barcode vom Foto einlesen**, **Taschenlampe**,
  **Nummer eintippen** als letzter Weg. Eine **EAN-13-Prüfziffer** (Drucker codiert
  13 Striche, Etikett zeigt 12 Ziffern) wird automatisch abgeschnitten — Scan,
  Etikett und Tippen ergeben dieselbe Nummer.
- **Aufbau / Abbau** als zwei Modi einer Liste. Im Abbau kennt die App die offenen Geräte des
  Projekts und warnt bei fehlenden (mit **Standort**), fremden oder negativen Ständen.
  **Tippfehler-Bremse** bei unplausiblen Zählerständen.
- **Neues Gerät** wird beim ersten Scan einmalig nach dem Gerätetyp gefragt, danach nie wieder.
  Optional je Gerät: **Standort** (Aufbau), **Notiz** („defekt"), **Foto vom Zähler**
  (Erinnerung/Pflicht pro Büro einstellbar).
- **Offline-first:** Jede Erfassung geht zuerst in IndexedDB. Der Sync gegen den Server läuft
  best-effort und automatisch nach, sobald wieder Netz da ist — nichts geht verloren.
  „**Alles gesendet?**"-Banner im Setup, solange Erfassungen warten.
- **Korrigieren statt neu erfassen:** vertippten kWh-Stand **oder** die Etikettennummer
  nachträglich ändern — Wert bzw. Nummer in der Liste oder in früheren Listen (Archiv)
  antippen (✎), neuen Stand/neue Nummer eingeben. Doppelte Nummern in derselben Liste
  sind gesperrt; bereits gesendete Zeilen werden am Server nachgezogen. Die ursprünglichen
  Werte bleiben dort nachvollziehbar (`kwh_alt`/`code_alt`), das Büro-Archiv kennzeichnet
  Korrekturen („korrigiert — Nr. war …").
- **Excel-Export** (SheetJS) als „Zettel fürs Büro", inkl. Gesamtverbrauch beim Abbau.
- **Archiv:** frühere Listen dieses Geräts (mit Löschen → **Papierkorb** → Wiederherstellen)
  und **Büro-Archiv** (geräteübergreifender Verlauf vom Server, mit Excel-Export).
- **Mehrere Baustellen:** die letzten Projekte als antippbare Chips im Setup;
  **Projektnummer scannen** statt tippen.

## Aufbau

Eine einzige, selbsttragende `index.html` (HTML + CSS + JS, keine Build-Kette). Die
Bibliotheken (ZXing, SheetJS) liegen lokal unter `vendor/` — kein CDN, echtes Offline.
Backend ist eine Supabase Edge Function (`/functions/v1/torrek-scan`), authentifiziert
über einen `x-app-code`-Header pro Liste; der Code liegt dokumentiert in `server/index.ts`.

| Datei | Zweck |
|---|---|
| `index.html` | komplette App (UI, Offline-Speicher, Scan, Sync, Export) |
| `vendor/` | lokal gebündelte Libs (ZXing, SheetJS) — statt CDN, für echtes Offline |
| `sw.js` | Service Worker (cacht App-Shell + Libs; Edge Function bleibt unberührt) |
| `manifest.webmanifest`, `icon.svg` | PWA-Manifest + Icon (installierbar) |
| `e2e.mjs` | hermetischer E2E-Golden-Path (Playwright) |
| `README.md` | dieses Dokument |

## Screens

`setup` (Liste anlegen, letzte Baustellen) → `scan` (Kamera, Licht, Foto-Scan) → `typ`
(nur bei neuem Gerät) → `wert` (Ziffernfeld + Standort/Notiz/Foto) → `liste` (Erfasstes +
Sync-Status) → `senden` (Abschluss + Excel). Daneben: `archiv` (frühere Listen + Büro-Archiv-
Suche) → `archivDetail` / `serverArchiv` und `papierkorb` (gelöschte Listen wiederherstellen).

## Lokal ansehen

Statisch ausliefern, z. B. `python3 -m http.server` im Ordner, dann `index.html` im Browser
öffnen. Kamera und Service Worker brauchen `https` bzw. `localhost`. Dank lokal gebündelter
Libs startet und scannt die App auch **beim ersten Mal offline**; nur Sync/Backend braucht Netz.

## Offline & Installierbar

- **Kein CDN mehr:** ZXing und SheetJS liegen unter `vendor/` — nichts wird beim Start
  nachgeladen. Beim Abgleich der Versionen die Dateinamen (`…-<version>.min.js`) mitziehen.
- **Service Worker** cacht die App-Shell und die Libs. Die **Edge Function wird nie gecacht**
  — Sync geht immer ans echte Netz, offline puffert die App selbst (IndexedDB).
- **Installierbar** über `manifest.webmanifest` (Display „standalone").

## Tests

Hermetischer E2E-Golden-Path (Playwright, echtes Chromium): startet einen eigenen statischen
Server und **mockt bzw. blockiert die Edge Function** — es geht nie ein echter Request an
Supabase raus. Deckt u. a. Setup, Aufbau, Abbau-Differenz, Offline, Hell/Dunkel, Büro-Archiv,
Standort, Löschen/Papierkorb, Tippfehler-Bremse, Foto-Erinnerung, letzte Baustellen und den
Scanner-Kern (selbst erzeugter CODE-128 durch den echten Foto-Weg) und die
Zählerstand- und Nummern-Korrektur ab — **62 Checks**.

```bash
# aus dem Repo-Wurzelverzeichnis (nutzt playwright-core aus dem Wurzel-node_modules)
node torrek-scan/e2e.mjs
```

## Deploy

Die App ist **komplett path-relativ** (alle Pfade relativ, Service-Worker-Scope und
`start_url` relativ) und läuft daher an jedem Ort — Site-Root **oder** Unterpfad. Verifiziert
unter `/torrek-scan/` (SW-Scope korrekt, Offline-Reload ok). `.nojekyll` verhindert Jekyll-
Verarbeitung, falls über GitHub Pages ausgeliefert.

**Wichtig:** GitHub Pages liefert pro Repo nur **eine** Quelle aus — im Monorepo `checkdrytrack`
ist das `hosting/` (DryTrack). Gewählter Weg: **eigenes Repo mit eigener Pages-Site**, damit
DryTracks Deploy unangetastet bleibt.

### Eigenes Repo (gewählter Weg)

Der Pages-Workflow liegt bereits unter `.github/workflows/pages.yml` (inert, solange dieser
Ordner Teil von `checkdrytrack` ist — Actions lesen nur Workflows im Repo-Wurzelverzeichnis).
So wird `torrek-scan` zu seinem eigenen Repo (Ordnerinhalt = Repo-Wurzel):

```bash
# 1) Öffentliches Repo anlegen: github.com/new  →  Name: torrek-scan  (ohne README)
# 2) Diesen Ordner als eigenes Repo pushen:
cp -r torrek-scan /tmp/torrek-scan && cd /tmp/torrek-scan
git init -b main && git add . && git commit -m "Torrek Scan v1"
git remote add origin https://github.com/hopperhater123-wq/torrek-scan.git
git push -u origin main
# 3) Repo → Settings → Pages → Source: „GitHub Actions"
```

Danach deployt jeder Push automatisch; URL: `https://hopperhater123-wq.github.io/torrek-scan/`.

## Design — „Field System"

Dunkler, technischer Look (Stand 16.07., vom Projektinhaber gestaltet): fast-schwarze Tinte
`#090B0D` mit feiner Rausch-Textur, **Acid-Grün** `#BCFF55` als Haupt-Akzent (Aufbau, Treffer,
Laser), **Cyan** `#71E4DF` (Abbau, Fokus), Orange/Rot `#FF7148`/`#E2574C` für Warnungen.
Monospace-Labels, großes vertikales „TORREK"-Wasserzeichen mit Parallax, Vorhang-Intro mit
Barcode-Animation, choreografierte Screenwechsel (nur beim Wechsel, nie beim Tippen).

**Hell-/Dunkelmodus** (Auto/Hell/Dunkel, im Setup umschaltbar, in `localStorage` gemerkt,
Voreinstellung folgt `prefers-color-scheme`). Nur die Flächen-/Text-Token drehen; die Akzente
tragen in beiden Modi dieselbe Bedeutung. `prefers-reduced-motion` wird vollständig respektiert.
