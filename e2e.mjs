/* Torrek Scan — hermetischer E2E-Golden-Path
   ------------------------------------------------------------------
   Startet einen eigenen statischen Server, fährt die App im echten
   Chromium und prüft Setup → Scan → Typ → Wert → Liste → Abschluss.
   HERMETISCH: Die Edge Function wird per Route abgefangen (gemockt bzw.
   blockiert) — es geht NIE ein echter Request an Supabase raus, damit
   Testläufe keine Daten in die geteilte Datenbank schreiben.

   Lauf:  node e2e.mjs           (aus dem Repo, nutzt playwright-core aus
                                  dem Wurzel-node_modules)
   Browser: /opt/pw-browsers/chromium  (oder $CHROMIUM_PATH)               */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.json':'application/json', '.webmanifest':'application/manifest+json',
  '.svg':'image/svg+xml', '.css':'text/css' };

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };

// ---- statischer Server (nur dieser Ordner) ----
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: EXE, headless: true,
  ignoreDefaultArgs: ['--headless=old'], args: ['--no-sandbox', '--headless=new'] });

// Mock-Antworten der Edge Function je nach aktion.
async function mockFn(ctx, { offen = [] } = {}) {
  const calls = [];                       // alle Requests an die (gemockte) Function
  await ctx.route('**/functions/v1/**', async route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    calls.push(body);
    const bodies = {
      stammdaten: { typen: [{ id: 't1', bezeichnung: 'Kondenstrockner TK-30' }, { id: 't2', bezeichnung: 'Ventilator V-9' }], bekannt: {} },
      projekt: { offen },
      erfassen: { geraet_neu_angelegt: true },
      korrigieren: { ok: true, kwh: body.kwh, code: body.code, kwh_alt: 0, differenz: null },
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bodies[body.aktion] ?? {}) });
  });
  return calls;
}

const setup = async (page, { code = 'CODE1', projekt = '2026 033996', mieter = 'Wimmer', modus = 'aufbau' } = {}) => {
  await page.fill('#c', code); await page.fill('#p', projekt); await page.fill('#m', mieter);
  if (modus === 'abbau') await page.click('.seg button:has-text("Abbau")');
  await page.click('text=Loslegen');
};
const onScanScreen = page => page.waitForSelector('.stage', { timeout: 8000 });
const tippen = async (page, code) => {
  await onScanScreen(page);
  page.once('dialog', d => d.accept(code));
  await page.click('text=Nummer eintippen');
};
const crumb = page => page.$eval('.crumb', el => el.textContent.trim());

try {
  // ============ Szenario A — Aufbau (online, gemockt) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const calls = await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);

    // Lokale Libs geladen (kein CDN)
    const libs = await page.evaluate(() => ({ z: typeof window.ZXing, x: typeof window.XLSX }));
    check('Libs lokal geladen (ZXing+XLSX)', libs.z === 'object' && libs.x === 'object');

    // Setup-Validierung: ohne Code/Projekt kein Start
    await page.fill('#c', ''); await page.fill('#p', '');
    await page.click('text=Loslegen'); await page.waitForTimeout(300);
    check('Setup: ohne Code/Projekt kein Start', await page.$('#c') !== null);

    await setup(page, {});
    await page.waitForTimeout(700);
    check('Scan-Screen erreicht', await page.$('.stage') !== null);

    // Neues Gerät → Typ-Screen zeigt die geladenen Typen (kein Leerzustand)
    await tippen(page, '123456789012');
    await page.waitForTimeout(500);
    const typBtns = await page.$$eval('.typen button', bs => bs.map(b => b.textContent.trim()));
    check('Typ-Screen listet geladene Typen', typBtns.some(t => t.includes('Kondenstrockner')));
    check('Kein Offline-Leerzustand bei geladenen Typen', await page.$('.banner.amber') === null);
    await page.click('.typen button:has-text("Kondenstrockner")');
    await page.waitForTimeout(400);

    // Wert eingeben
    for (const n of '4217') await page.click(`.pad button:has-text("${n}")`);
    await page.waitForTimeout(200);
    check('Readout zeigt eingegebenen Wert', (await page.$eval('.num', e => e.textContent.replace(/\s/g, ''))) === '4217');
    await page.click('text=Speichern');
    await page.waitForTimeout(900);

    check('Zurück im Scan, 1 erfasst', (await page.$eval('.sub b', e => e.textContent.trim())) === '1');

    // Sync erfolgreich (Mock) → Status synced (↑)
    await page.click('button:has-text("Liste")');
    await page.waitForTimeout(1200);
    check('Liste-Crumb Singular "1 Gerät"', (await crumb(page)) === '1 Gerät');
    check('Zeile nach Sync = synced (↑)', (await page.$eval('.row .st', e => e.textContent.trim())) === '↑');

    // Zweites Gerät → Plural
    await page.click('button:has-text("Weiter scannen")');
    await page.waitForTimeout(500);
    await tippen(page, '222333444555');
    await page.waitForTimeout(500);
    await page.click('.typen button:has-text("Ventilator")');
    await page.waitForTimeout(400);
    for (const n of '5000') await page.click(`.pad button:has-text("${n}")`);
    await page.click('text=Speichern');
    await page.waitForTimeout(800);
    await page.click('button:has-text("Liste")');
    await page.waitForTimeout(700);
    check('Liste-Crumb Plural "2 Geräte"', (await crumb(page)) === '2 Geräte');

    // Korrektur (vertippt): Wert antippen -> neuer Stand -> geht als "korrigieren" raus
    page.once('dialog', d => d.accept('4300'));
    await page.click('.row .val.korr');
    await page.waitForTimeout(1000);
    const valNeu = await page.$eval('.row .val', e => e.textContent.replace(/\s/g, ''));
    check('Korrektur: Liste zeigt neuen Wert (4.300)', valNeu.includes('4.300'));
    check('Korrektur ging als "korrigieren" an den Server', calls.some(c => c.aktion === 'korrigieren' && c.kwh === 4300));
    check('Korrigierte Zeile wieder synced (↑)', (await page.$eval('.row .st', e => e.textContent.trim())) === '↑');

    // Ungültige Eingabe wird abgewiesen, Wert bleibt
    page.once('dialog', d => d.accept('abc'));
    await page.click('.row .val.korr');
    await page.waitForTimeout(500);
    check('Korrektur: Unsinn wird abgewiesen', (await page.$eval('.row .val', e => e.textContent.replace(/\s/g, ''))).includes('4.300'));

    // EAN-Prüfziffer: gültige 13. Ziffer wird abgeschnitten, ungültige bleibt
    const ean = await page.evaluate(() => [ohnePruefziffer('5100000026095'), ohnePruefziffer('5100000026094'), ohnePruefziffer('123456789012')]);
    check('EAN-13: gültige Prüfziffer wird abgeschnitten', ean[0] === '510000002609');
    check('EAN-13: falsche Prüfziffer bleibt unangetastet', ean[1] === '5100000026094');
    check('12-Steller bleibt unverändert', ean[2] === '123456789012');

    // Nummern-Korrektur: Code antippen -> neue Nummer (mit Prüfziffer, wird gestutzt)
    page.once('dialog', d => d.accept('5100000026095'));
    await page.click('.row .id .korr');
    await page.waitForTimeout(1000);
    const idNeu = await page.$eval('.row .id', e => e.textContent);
    check('Nummer korrigiert + Prüfziffer gestutzt (510000002609)', idNeu.includes('510000002609'));
    check('Nummern-Korrektur ging als "korrigieren" mit code raus', calls.some(c => c.aktion === 'korrigieren' && c.code === '510000002609'));

    // Doppel-Wächter: Nummer der zweiten Zeile auf die erste setzen -> abgelehnt
    page.once('dialog', d => d.accept('510000002609'));
    await page.click('.row:nth-of-type(2) .id .korr');
    await page.waitForTimeout(500);
    const zweite = await page.$eval('.row:nth-of-type(2) .id', e => e.textContent);
    check('Doppel-Wächter: Nummer bleibt bei Kollision unverändert', zweite.includes('222333444555'));

    // Excel-Erzeugung wirft nicht (Aufbau)
    const excelOk = await page.evaluate(() => { try { XLSX.write(wb(), { bookType: 'xlsx', type: 'array' }); return true; } catch { return false; } });
    check('Excel-Workbook baut ohne Fehler (Aufbau)', excelOk);

    // Archiv: erfasste Liste erscheint und Detail zeigt exaktes Datum + Uhrzeit
    await page.evaluate(() => go('archiv'));
    await page.waitForTimeout(400);
    const aids = await page.$$eval('.arow .aid', els => els.map(e => e.textContent.trim()));
    check('Archiv listet die erfasste Liste', aids.includes('2026 033996'));
    await page.click('.arow');
    await page.waitForTimeout(300);
    const dt = await page.$eval('.row .id small', e => e.textContent.trim()).catch(() => '');
    check('Archiv-Detail zeigt exaktes Datum + Uhrzeit', /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/.test(dt));

    await ctx.close();
  }

  // ============ Szenario B — Abbau (Differenz + Warnungen) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx, { offen: [{ geraet_inventarnummer: '999888777666', zaehlerstand_start: 1000 }] });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, { modus: 'abbau' });
    await page.waitForTimeout(800);

    // Fremdes Gerät (nicht in offen) wird abgelehnt
    await tippen(page, '111111111111');
    await page.waitForTimeout(500);
    check('Abbau: fremdes Gerät abgelehnt (bleibt im Scan)', await page.$('.stage') !== null);

    // Offenes Gerät: Endstand < Startstand → negative Differenz
    await tippen(page, '999888777666');
    await page.waitForTimeout(500);
    // ggf. Typ fragen
    if (await page.$('.typen')) { await page.click('.typen button'); await page.waitForTimeout(400); }
    check('Abbau: Aufbau-Startstand wird angezeigt', (await page.$eval('.banner.amber', e => e.textContent).catch(() => '')).includes('1.000'));
    for (const n of '900') await page.click(`.pad button:has-text("${n}")`);
    // Neu (#3): kleiner-als-Aufbau löst eine Plausibilitäts-Rückfrage aus — bestätigen.
    page.once('dialog', d => d.accept());
    await page.click('text=Speichern');
    await page.waitForTimeout(800);
    await page.click('button:has-text("Liste")');
    await page.waitForTimeout(700);
    check('Abbau: negative Differenz wird gemeldet', (await page.$('.banner.red') !== null));
    const diffTxt = await page.$eval('.row .val', e => e.textContent).catch(() => '');
    check('Abbau: Differenz -100 in der Zeile', diffTxt.replace(/[^\d-]/g, '').includes('-100'));

    await ctx.close();
  }

  // ============ Szenario C — Offline-Leerzustand (FN blockiert) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/functions/v1/**', r => r.abort());
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});
    await page.waitForTimeout(700);
    await tippen(page, '123456789012');
    await page.waitForTimeout(500);
    check('Offline: Typ-Leerzustand mit Hinweis', await page.$('.banner.amber') !== null);
    check('Offline: Button "Ohne Typ weiter"', (await page.$eval('.typen .unk', e => e.textContent.trim())) === 'Ohne Typ weiter');
    // Erfassung bleibt trotzdem lokal möglich
    await page.click('.typen .unk');
    await page.waitForTimeout(300);
    for (const n of '1234') await page.click(`.pad button:has-text("${n}")`);
    await page.click('text=Speichern');
    await page.waitForTimeout(800);
    await page.click('button:has-text("Liste")');
    await page.waitForTimeout(500);
    check('Offline: Erfassung lokal gespeichert (1 Gerät)', (await crumb(page)) === '1 Gerät');
    await ctx.close();
  }

  // ============ Szenario D — Darstellung (Hell/Dunkel) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    check('Start hell (data-theme=light)', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
    await page.fill('#p', '2026 000111');
    await page.click('.seg button:has-text("Dunkel")');
    await page.waitForTimeout(300);
    check('Umschalten auf Dunkel wirkt', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    check('Theme-Wechsel behält getippte Felder', (await page.inputValue('#p')) === '2026 000111');
    const inpRgb = (await page.evaluate(() => getComputedStyle(document.getElementById('p')).color)).match(/\d+/g).map(Number);
    check('Dunkel: Eingabetext ist hell (lesbar)', inpRgb[0] > 150 && inpRgb[1] > 150 && inpRgb[2] > 150);
    await ctx.close();
  }

  // ============ Szenario E — Büro-Archiv (Server-Verlauf, gemockt) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/functions/v1/**', async route => {
      let aktion = ''; try { aktion = JSON.parse(route.request().postData() || '{}').aktion; } catch {}
      if (aktion === 'verlauf') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projektnummer: '2026 000999', erfassungen: [
          { code: '111111111111', modus: 'aufbau', kwh: 1000, differenz: null, erfasst_am: '2026-06-25T08:12:00Z', typ: 'TK-30', mieter: 'X' },
          { code: '111111111111', modus: 'abbau', kwh: 1217, differenz: 217, erfasst_am: '2026-07-16T09:00:00Z', typ: 'TK-30', mieter: 'X' },
        ] }) });
      } else await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await page.evaluate(() => go('archiv'));
    await page.waitForTimeout(300);
    await page.fill('#archivsuche', '2026 000999');
    await page.click('text=Büro-Archiv suchen');
    await page.waitForTimeout(500);
    check('Büro-Archiv: Gesamtverbrauch vom Server (217)', (await page.$eval('.total .big', e => e.textContent).catch(() => '')).includes('217'));
    check('Büro-Archiv: exaktes Datum + Uhrzeit vom Server', /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/.test(await page.$eval('.row .id small', e => e.textContent.trim()).catch(() => '')));
    await ctx.close();
  }

  // ============ Szenario F — Standort je Gerät ============
  {
    // F1: Aufbau speichert einen Standort → erscheint im Archiv
    const ctxA = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctxA);
    const pageA = await ctxA.newPage();
    await pageA.goto(base, { waitUntil: 'load' });
    await pageA.waitForTimeout(2600);
    await setup(pageA, {});
    await onScanScreen(pageA);
    await tippen(pageA, '123456789012');
    await pageA.waitForTimeout(400);
    if (await pageA.$('.typen')) { await pageA.click('.typen button'); await pageA.waitForTimeout(300); }
    await pageA.fill('input[placeholder*="Keller"]', 'Keller links');
    for (const n of '4217') await pageA.click(`.pad button:has-text("${n}")`);
    await pageA.click('text=Speichern');
    await pageA.waitForTimeout(500);
    await pageA.evaluate(() => go('archiv'));
    await pageA.waitForTimeout(300);
    await pageA.click('.arow');
    await pageA.waitForTimeout(300);
    check('Aufbau-Standort erscheint im Archiv', (await pageA.$eval('.row .id small', e => e.textContent).catch(() => '')).includes('Keller links'));
    await ctxA.close();

    // F2: Abbau-Warnung nennt den Standort des vergessenen Geräts (vom Server)
    const ctxB = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctxB.route('**/functions/v1/**', async route => {
      let aktion = ''; try { aktion = JSON.parse(route.request().postData() || '{}').aktion; } catch {}
      const bodies = { stammdaten: { typen: [], bekannt: {} }, erfassen: { ok: true },
        projekt: { offen: [{ geraet_inventarnummer: '999888777666', zaehlerstand_start: 1000, standort: 'Keller links' }] } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bodies[aktion] ?? {}) });
    });
    const pageB = await ctxB.newPage();
    await pageB.goto(base, { waitUntil: 'load' });
    await pageB.waitForTimeout(2600);
    await setup(pageB, { modus: 'abbau' });
    await onScanScreen(pageB);
    await pageB.click('button:has-text("Liste")');
    await pageB.waitForTimeout(500);
    check('Abbau-Warnung nennt den Standort', (await pageB.$eval('.banner.red', e => e.textContent.replace(/\s+/g, ' ')).catch(() => '')).includes('Keller links'));
    await ctxB.close();
  }

  // ============ Szenario G — Liste löschen (Warnung) + Papierkorb (Wiederherstellen) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});
    await onScanScreen(page);
    await tippen(page, '123456789012');
    await page.waitForTimeout(400);
    if (await page.$('.typen')) { await page.click('.typen button'); await page.waitForTimeout(300); }
    for (const n of '4217') await page.click(`.pad button:has-text("${n}")`);
    await page.click('text=Speichern');
    await page.waitForTimeout(500);
    await page.evaluate(() => go('archiv'));
    await page.waitForTimeout(300);
    check('Vor Löschen: Liste im Archiv', (await page.$$('#archivliste .arow')).length >= 1);
    await page.click('.arow');
    await page.waitForTimeout(300);
    page.once('dialog', d => d.accept());   // Warnung „wirklich löschen?" bestätigen
    await page.click('text=Liste löschen');
    await page.waitForTimeout(400);
    check('Nach Löschen: Papierkorb-Button erscheint', await page.$('button:has-text("Papierkorb (")') !== null);
    check('Nach Löschen: Archiv-Liste leer', (await page.$$('#archivliste .arow')).length === 0);
    // Eindeutiger Button-Selektor: der Toast enthält ebenfalls „Papierkorb",
    // daher würde ein reiner Text-Selektor mehrdeutig treffen (Strict-Mode).
    await page.click('button:has-text("Papierkorb (")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("Wiederherstellen")');
    await page.waitForTimeout(400);
    await page.evaluate(() => go('archiv'));
    await page.waitForTimeout(300);
    check('Wiederhergestellt: Liste zurück im Archiv', (await page.$$('#archivliste .arow')).length >= 1);
    await ctx.close();
  }

  // ============ Szenario H — Tippfehler-Warnung beim Zählerstand ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});
    await onScanScreen(page);
    await tippen(page, '123456789012');
    await page.waitForTimeout(400);
    if (await page.$('.typen')) { await page.click('.typen button'); await page.waitForTimeout(300); }
    // 7-stelliger Wert (≥ 1.000.000) → Plausibilitäts-Rückfrage
    for (const n of '1234567') await page.click(`.pad button:has-text("${n}")`);
    let gefragt = false;
    page.once('dialog', d => { gefragt = true; d.accept(); });
    await page.click('text=Speichern');
    await page.waitForTimeout(500);
    check('Zählerstand: unplausibler Wert fragt nach', gefragt);
    await page.click('button:has-text("Liste")');
    await page.waitForTimeout(500);
    check('Zählerstand: nach Bestätigung gespeichert', (await crumb(page)) === '1 Gerät');
    await ctx.close();
  }

  // ============ Szenario I — Taschenlampe (Knopf da, kein Absturz ohne Kamera) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});
    await onScanScreen(page);
    check('Scanner: Taschenlampen-Knopf vorhanden', await page.$('#torchbtn') !== null);
    await page.click('#torchbtn');   // ohne echte Kamera → Hinweis-Toast statt Absturz
    await page.waitForTimeout(300);
    check('Taschenlampe: App bleibt bedienbar', await page.$('.stage') !== null);
    await ctx.close();
  }

  // ============ Szenario J — Projektnummer per Scan ins Feld ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    check('Setup: Projektnummer-Scan-Knopf vorhanden', await page.$('text=Projektnummer scannen') !== null);
    // Dekodierten Code einspeisen → füllt das Projektfeld (ohne echte Kamera)
    await page.evaluate(() => verarbeiteScan('2026 424242', 'projekt'));
    await page.waitForTimeout(200);
    check('Projektnummer-Scan füllt das Feld', (await page.inputValue('#p')) === '2026 424242');
    check('Projektnummer-Scan behält Leerzeichen (kein Ziffernfilter)', (await page.inputValue('#p')).includes(' '));
    await ctx.close();
  }

  // ============ Szenario K — Notiz je Gerät ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});
    await onScanScreen(page);
    await tippen(page, '123456789012');
    await page.waitForTimeout(400);
    if (await page.$('.typen')) { await page.click('.typen button'); await page.waitForTimeout(300); }
    await page.fill('input[placeholder*="defekt"]', 'läuft nicht');
    for (const n of '4217') await page.click(`.pad button:has-text("${n}")`);
    await page.click('text=Speichern');
    await page.waitForTimeout(600);
    await page.click('button:has-text("Liste")');
    await page.waitForTimeout(500);
    check('Notiz erscheint in der Liste', (await page.$eval('.row .id small', e => e.textContent).catch(() => '')).includes('läuft nicht'));
    const excelOk = await page.evaluate(() => { try { XLSX.write(wb(), { bookType: 'xlsx', type: 'array' }); return true; } catch { return false; } });
    check('Excel mit Notiz-Spalte baut ohne Fehler', excelOk);
    await page.evaluate(() => go('archiv'));
    await page.waitForTimeout(300);
    await page.click('.arow');
    await page.waitForTimeout(300);
    check('Notiz erscheint im Archiv-Detail', (await page.$eval('.row .id small', e => e.textContent).catch(() => '')).includes('läuft nicht'));
    await ctx.close();
  }

  // ============ Szenario L — Foto-Erinnerung (Büro-Einstellung "hinweis") ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/functions/v1/**', async route => {
      let aktion = ''; try { aktion = JSON.parse(route.request().postData() || '{}').aktion; } catch {}
      const bodies = {
        stammdaten: { typen: [{ id: 't1', bezeichnung: 'Kondenstrockner TK-30' }], bekannt: {}, einstellungen: { foto_pflicht: 'hinweis' } },
        projekt: { offen: [] }, erfassen: { ok: true },
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bodies[aktion] ?? {}) });
    });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});
    await onScanScreen(page);
    await tippen(page, '123456789012');
    await page.waitForTimeout(400);
    if (await page.$('.typen')) { await page.click('.typen button'); await page.waitForTimeout(300); }
    for (const n of '4217') await page.click(`.pad button:has-text("${n}")`);
    let fotoGefragt = false;
    page.once('dialog', d => { fotoGefragt = d.message().includes('Foto'); d.accept(); });
    await page.click('text=Speichern');
    await page.waitForTimeout(600);
    check('Foto-Hinweis: ohne Foto wird nachgefragt', fotoGefragt);
    await page.click('button:has-text("Liste")');
    await page.waitForTimeout(500);
    check('Foto-Hinweis: nach Bestätigung gespeichert', (await crumb(page)) === '1 Gerät');
    await ctx.close();
  }

  // ============ Szenario M — „Alles gesendet?"-Check im Setup ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/functions/v1/**', r => r.abort());   // offline → Erfassung bleibt pending
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});
    await onScanScreen(page);
    await tippen(page, '123456789012');
    await page.waitForTimeout(400);
    if (await page.$('.typen')) { await page.click('.typen .unk'); await page.waitForTimeout(300); }
    for (const n of '1234') await page.click(`.pad button:has-text("${n}")`);
    await page.click('text=Speichern');
    await page.waitForTimeout(600);
    await page.evaluate(() => go('setup'));
    await page.waitForTimeout(400);
    const bannerTxt = await page.$eval('.banner.amber', e => e.textContent).catch(() => '');
    check('Setup: „Alles gesendet?"-Banner bei offenen Erfassungen', bannerTxt.includes('Alles gesendet?'));
    check('Setup: „Jetzt senden"-Knopf vorhanden', await page.$('button:has-text("Jetzt senden")') !== null);
    await ctx.close();
  }

  // ============ Szenario N — Letzte Baustellen (schneller Projektwechsel) ============
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    await setup(page, {});                       // merkt „2026 033996 · Wimmer"
    await onScanScreen(page);
    await page.evaluate(() => go('setup'));
    await page.waitForTimeout(400);
    check('Setup: Letzte-Baustellen-Chip erscheint', await page.$('button.chip:has-text("2026 033996")') !== null);
    await page.fill('#p', '');                   // Feld leeren, dann per Chip wechseln
    await page.click('button.chip:has-text("2026 033996")');
    await page.waitForTimeout(300);
    check('Chip füllt Projektnummer wieder ein', (await page.inputValue('#p')) === '2026 033996');
    check('Chip füllt Mieter wieder ein', (await page.inputValue('#m')) === 'Wimmer');
    await ctx.close();
  }

  // ============ Szenario O — Scanner-Kern: CODE-128-Roundtrip (speicherarmer Weg) ============
  // Erzeugt einen echten CODE-128 im Browser und prüft BEIDE neuen Pfade:
  // 1) leseCanvas (ZXing direkt vom Canvas, ohne dataURL) und
  // 2) den kompletten Foto-Weg barcodeAusBild(File) bis zum Typ-Screen.
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await mockFn(ctx);
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(2600);

    const libOk = await page.evaluate(() =>
      typeof ZXing.HTMLCanvasElementLuminanceSource === 'function' &&
      typeof ZXing.MultiFormatReader === 'function' && typeof ZXing.HybridBinarizer === 'function');
    check('ZXing-Canvas-Bausteine im Bundle vorhanden', libOk);

    // CODE-128 (Zeichensatz C) zeichnen und direkt lesen
    const rt = await page.evaluate(() => {
      const T = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232'];
      const code = '800000006120';
      const vals = [105];
      for (let i = 0; i < code.length; i += 2) vals.push(parseInt(code.slice(i, i + 2), 10));
      let ck = vals[0]; for (let i = 1; i < vals.length; i++) ck += vals[i] * i;
      vals.push(ck % 103);
      const widths = vals.map(v => T[v]).join('') + '2331112';
      const modul = 3, ruhe = 12 * modul, h = 100;
      const gesamt = widths.split('').reduce((a, c) => a + +c, 0) * modul + 2 * ruhe;
      const cv = document.createElement('canvas'); cv.width = gesamt; cv.height = h;
      const g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, gesamt, h);
      g.fillStyle = '#000';
      let x = ruhe, balken = true;
      for (const c of widths) { const w = +c * modul; if (balken) g.fillRect(x, 8, w, h - 16); x += w; balken = !balken; }
      window.__bcv = cv;                       // für Teil 2 aufheben
      return leseCanvas(cv);
    });
    check('leseCanvas dekodiert CODE-128 (800000006120)', rt === '800000006120');

    // Kompletter Foto-Weg: File → barcodeAusBild → Typ-Screen mit Chip
    await setup(page, {});
    await onScanScreen(page);
    await page.evaluate(async () => {
      const blob = await new Promise(r => window.__bcv.toBlob(r, 'image/png'));
      await barcodeAusBild(new File([blob], 'etikett.png', { type: 'image/png' }), 'geraet');
    });
    await page.waitForTimeout(700);
    const chipTxt = await page.$eval('.chip', e => e.textContent).catch(() => '');
    check('Foto-Weg: Barcode-Foto führt zum Typ-Screen', chipTxt.includes('800000006120'));
    await ctx.close();
  }
} catch (e) {
  check('Testlauf ohne unerwartete Ausnahme', false);
  console.error('\nAusnahme:', e && e.message);
}

await browser.close();
await new Promise(r => server.close(r));

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} Checks bestanden.`);
process.exit(failed.length ? 1 : 0);
