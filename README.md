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

- **Barcode-Scan** (CODE-128) über die Rückkamera, ZXing im Browser; Fallback: Nummer eintippen.
- **Aufbau / Abbau** als zwei Modi einer Liste. Im Abbau kennt die App die offenen Geräte des
  Projekts und warnt bei fehlenden, fremden oder negativen Ständen.
- **Neues Gerät** wird beim ersten Scan einmalig nach dem Gerätetyp gefragt, danach nie wieder.
- **Offline-first:** Jede Erfassung geht zuerst in IndexedDB. Der Sync gegen den Server läuft
  best-effort und automatisch nach, sobald wieder Netz da ist — nichts geht verloren.
- **Excel-Export** (SheetJS) als „Zettel fürs Büro", inkl. Gesamtverbrauch beim Abbau.

## Aufbau

Eine einzige, selbsttragende `index.html` (HTML + CSS + JS, keine Build-Kette). Externe
Bibliotheken (ZXing, SheetJS) werden per CDN geladen. Backend ist eine Supabase Edge Function
(`/functions/v1/torrek-scan`), authentifiziert über einen `x-app-code`-Header pro Liste.

| Datei | Zweck |
|---|---|
| `index.html` | komplette App (UI, Offline-Speicher, Scan, Sync, Export) |
| `vendor/` | lokal gebündelte Libs (ZXing, SheetJS) — statt CDN, für echtes Offline |
| `sw.js` | Service Worker (cacht App-Shell + Libs; Edge Function bleibt unberührt) |
| `manifest.webmanifest`, `icon.svg` | PWA-Manifest + Icon (installierbar) |
| `e2e.mjs` | hermetischer E2E-Golden-Path (Playwright) |
| `README.md` | dieses Dokument |

## Screens

`setup` (Liste anlegen) → `scan` (Kamera) → `typ` (nur bei neuem Gerät) → `wert`
(Ziffernfeld + Foto) → `liste` (Erfasstes + Sync-Status) → `senden` (Abschluss + Excel).

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
Supabase raus. Deckt Setup, Aufbau, Abbau-Differenz, Grammatik (1 Gerät / 2 Geräte),
Sync-Status und den Offline-Leerzustand ab (18 Checks).

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

## Design

Gestaltungsprinzip „Feldinstrument": Papier `#FBF9F5` / Tinte `#1C1A17`, **Petrol** `#0F7C86`
als bedeutungsfreier Marken-/Interaktions-Akzent (Fokus, Display-Rahmen, „Scan"-Wortmarke),
dunkles Ablese-Display mit Monospace-Ziffern, animiertes Barcode-Intro, dezente CSS-3D-Tiefe.

**Farb-Bedeutung strikt getrennt:** Bernstein `#E8A33D` = **Aufbau**-Status, Grün `#5FA777`
= **Abbau**/Erfolg, Koralle `#E2574C` = Warnung/Laser. Diese Ampel-/Statusfarben sind für
Bewertung/Status reserviert; für Deko dient allein Petrol.

**Hell-/Dunkelmodus** (Auto/Hell/Dunkel, im Setup umschaltbar, in `localStorage` gemerkt,
Voreinstellung folgt `prefers-color-scheme`). Nur die Flächen-/Text-Token drehen; die Akzente
tragen in beiden Modi dieselbe Bedeutung. `prefers-reduced-motion` wird vollständig respektiert.
