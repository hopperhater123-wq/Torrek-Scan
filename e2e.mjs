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
  await ctx.route('**/functions/v1/**', async route => {
    let aktion = '';
    try { aktion = JSON.parse(route.request().postData() || '{}').aktion; } catch {}
    const bodies = {
      stammdaten: { typen: [{ id: 't1', bezeichnung: 'Kondenstrockner TK-30' }, { id: 't2', bezeichnung: 'Ventilator V-9' }], bekannt: {} },
      projekt: { offen },
      erfassen: { geraet_neu_angelegt: true },
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bodies[aktion] ?? {}) });
  });
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
    await mockFn(ctx);
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
} catch (e) {
  check('Testlauf ohne unerwartete Ausnahme', false);
  console.error('\nAusnahme:', e && e.message);
}

await browser.close();
await new Promise(r => server.close(r));

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} Checks bestanden.`);
process.exit(failed.length ? 1 : 0);
