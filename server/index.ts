// Torrek Scan — Edge Function (Supabase, Deno).
// ÜBERGANGSLÖSUNG, bewusst isoliert:
//   - Schreibt AUSSCHLIESSLICH in scan_erfassung. Kein Schreibzugriff auf
//     geraet/projekt/einsatz (DryTrack-Tabellen bleiben unberührt).
//   - geraetetyp wird NUR gelesen, damit die Typ-Liste dieselbe ist.
//   - Abschaltbar per: drop table scan_erfassung, scan_einstellung;
//
// Diese Datei dokumentiert die Function im Repo. Sie ist deploybar als
// Function-Slug „torrek-scan" im Supabase-Projekt zkuawtrwtmxhayshuxzv.
//
// NEU (Archiv): aktion "verlauf" — liest zu einer Projektnummer ALLE
// Erfassungen (Aufbau + Abbau, geräteübergreifend) rein aus scan_erfassung,
// inkl. serverseitig berechneter Differenz. Read-only, additiv.
//
// v4 (Feld-Helfer): Notiz je Gerät (Spalte scan_erfassung.notiz, additiv)
// wird gespeichert und im Verlauf ausgegeben; "stammdaten" liefert zusätzlich
// Büro-Einstellungen (foto_pflicht: aus | hinweis | pflicht) aus scan_einstellung.
//
// v6 (Korrektur): aktion "korrigieren" — vertippten kWh-Stand einer Erfassung
// ändern (Spalten kwh_alt + korrigiert_am, additiv). Der ursprüngliche Wert
// bleibt in kwh_alt nachvollziehbar; der Verlauf kennzeichnet Korrekturen.
//
// v7: "korrigieren" kann zusätzlich die Etikettennummer (code) ändern —
// mit Doppel-Wächter je Projekt+Modus; code_alt behält die erste Nummer.
//
// v8 (mehrere Mieter je Liste): "projekt" (offen) liefert den Mieter des
// Aufbaus mit, damit der Abbau ihn je Gerät erbt; Einstellungen zusätzlich
// buero_email (optional) für den E-Mail-Entwurf der App.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-code",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const norm = (s: unknown) => String(s ?? "").trim();

async function pruefeCode(code: string) {
  const { data } = await db.from("scan_einstellung")
    .select("wert").eq("schluessel", "app_code").maybeSingle();
  return !!data?.wert && norm(code) === norm(data.wert);
}

async function fotoAblegen(dataUrl: string, pfad: string) {
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl ?? "");
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  const { error } = await db.storage.from("zaehlerfotos")
    .upload(pfad, bytes, { contentType: m[1], upsert: true });
  return error ? null : pfad;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ fehler: "Nur POST" }, 405);
  try {
    if (!await pruefeCode(req.headers.get("x-app-code") ?? "")) {
      return json({ fehler: "Zugangscode stimmt nicht" }, 401);
    }
    const b = await req.json();

    // Typ-Liste (nur lesend aus geraetetyp) + bisher gescannte Typen aus der EIGENEN Tabelle
    // + Büro-Einstellungen (z. B. foto_pflicht), damit die App sie offline cachen kann.
    if (b.aktion === "stammdaten") {
      const { data: typen } = await db.from("geraetetyp")
        .select("id, bezeichnung").order("bezeichnung");
      const { data: gesehen } = await db.from("scan_erfassung")
        .select("code, typ_id").not("typ_id", "is", null);
      const bekannt: Record<string, string> = {};
      for (const g of gesehen ?? []) bekannt[g.code] = g.typ_id!;
      const { data: einst } = await db.from("scan_einstellung")
        .select("schluessel, wert").in("schluessel", ["foto_pflicht", "buero_email"]);
      const einstellungen: Record<string, string> = {};
      for (const e of einst ?? []) einstellungen[e.schluessel] = e.wert;
      return json({ typen: typen ?? [], bekannt, einstellungen });
    }

    // Offene Aufbäuten eines Projekts = Aufbau vorhanden, Abbau fehlt.
    if (b.aktion === "projekt") {
      const pn = norm(b.projektnummer);
      const { data: alle } = await db.from("scan_erfassung")
        .select("code, modus, kwh, erfasst_am, typ_id, standort, mieter")
        .eq("projektnummer", pn).order("erfasst_am");
      const auf = (alle ?? []).filter((r) => r.modus === "aufbau");
      const ab = new Set((alle ?? []).filter((r) => r.modus === "abbau").map((r) => r.code));
      return json({
        offen: auf.filter((r) => !ab.has(r.code)).map((r) => ({
          geraet_inventarnummer: r.code,
          zaehlerstand_start: Number(r.kwh),
          aufbau_datum: r.erfasst_am,
          standort: r.standort ?? null,
          mieter: r.mieter ?? null,
        })),
      });
    }

    // NEU — Archiv/Verlauf: alle Erfassungen zu einer Projektnummer,
    // geräteübergreifend, rein aus scan_erfassung. Read-only.
    if (b.aktion === "verlauf") {
      const pn = norm(b.projektnummer);
      if (!pn) return json({ fehler: "Projektnummer fehlt" }, 400);
      const { data: alle } = await db.from("scan_erfassung")
        .select("local_id, code, modus, kwh, mieter, typ_id, foto_ref, erfasst_am, standort, notiz, kwh_alt, code_alt, korrigiert_am")
        .eq("projektnummer", pn).order("erfasst_am");
      const rows = alle ?? [];
      // Typ-Bezeichnungen (read-only aus geraetetyp)
      const { data: typen } = await db.from("geraetetyp").select("id, bezeichnung");
      const typName: Record<string, string> = {};
      for (const t of typen ?? []) typName[t.id] = t.bezeichnung;
      // Aufbau-Stände je Gerät für die Differenz
      const aufKwh: Record<string, number> = {};
      for (const r of rows) if (r.modus === "aufbau") aufKwh[r.code] = Number(r.kwh);
      const erfassungen = rows.map((r) => ({
        local_id: r.local_id,
        code: r.code,
        modus: r.modus,
        kwh: Number(r.kwh),
        mieter: r.mieter,
        typ_id: r.typ_id,
        typ: r.typ_id ? (typName[r.typ_id] ?? null) : null,
        erfasst_am: r.erfasst_am,
        standort: r.standort ?? null,
        notiz: r.notiz ?? null,
        differenz: r.modus === "abbau" && aufKwh[r.code] != null
          ? +(Number(r.kwh) - aufKwh[r.code]).toFixed(2) : null,
        hat_foto: !!r.foto_ref,
        korrigiert: r.korrigiert_am != null,
        kwh_alt: r.kwh_alt != null ? Number(r.kwh_alt) : null,
        code_alt: r.code_alt ?? null,
      }));
      return json({ projektnummer: pn, erfassungen });
    }

    // v6/v7 — Korrektur: Zählerstand UND/ODER Etikettennummer einer bestehenden
    // Erfassung ändern. Nachvollziehbar: kwh_alt/code_alt behalten den ERSTEN
    // Wert, korrigiert_am den Zeitpunkt. Konsistenz: kein Doppel im Projekt,
    // Abbau-Stand nicht unter dem Aufbau-Stand des (ggf. neuen) Gegenstücks.
    if (b.aktion === "korrigieren") {
      const local_id = norm(b.local_id);
      if (!local_id) return json({ fehler: "local_id fehlt" }, 400);
      const { data: row } = await db.from("scan_erfassung")
        .select("local_id, projektnummer, code, modus, kwh, kwh_alt, code_alt")
        .eq("local_id", local_id).maybeSingle();
      if (!row) return json({ fehler: "Erfassung nicht gefunden" }, 404);

      const kwh = b.kwh === undefined ? Number(row.kwh) : Number(b.kwh);
      if (!isFinite(kwh) || kwh < 0) return json({ fehler: "Ungültiger Zählerstand" }, 400);
      const code = b.code === undefined ? row.code : norm(b.code);
      if (!/^\d{6,14}$/.test(code)) return json({ fehler: "Ungültige Etikettennummer" }, 400);

      const { data: andere } = await db.from("scan_erfassung")
        .select("modus, kwh, code").eq("projektnummer", row.projektnummer).neq("local_id", local_id);
      // Doppel-Wächter: dieselbe Nummer im selben Modus existiert schon
      if ((andere ?? []).some((r) => r.code === code && r.modus === row.modus)) {
        return json({ fehler: `Für ${code} gibt es in diesem Projekt schon eine ${row.modus === "aufbau" ? "Aufbau" : "Abbau"}-Erfassung.` }, 409);
      }
      const gegen = (andere ?? []).find((r) => r.code === code && r.modus !== row.modus);
      if (gegen) {
        const start = row.modus === "aufbau" ? kwh : Number(gegen.kwh);
        const ende = row.modus === "abbau" ? kwh : Number(gegen.kwh);
        if (ende < start) return json({ fehler: "Endstand darf nicht kleiner als der Aufbau-Stand sein." }, 409);
      }

      const patch: Record<string, unknown> = {};
      if (code !== row.code) { patch.code = code; patch.code_alt = row.code_alt ?? row.code; }
      if (kwh !== Number(row.kwh)) { patch.kwh = kwh; patch.kwh_alt = row.kwh_alt ?? row.kwh; }
      if (!Object.keys(patch).length) return json({ ok: true, unveraendert: true, kwh, code, differenz: null });
      patch.korrigiert_am = new Date().toISOString();
      const { error } = await db.from("scan_erfassung").update(patch).eq("local_id", local_id);
      if (error) throw new Error(error.message);

      const diff = gegen
        ? +((row.modus === "abbau" ? kwh : Number(gegen.kwh)) - (row.modus === "aufbau" ? kwh : Number(gegen.kwh))).toFixed(2)
        : null;
      const warnung = row.modus === "abbau" && !gegen
        ? "Für diese Nummer gibt es in diesem Projekt keinen Aufbau."
        : diff != null && diff < 0 ? "Differenz negativ — Zähler übergelaufen oder vertippt." : null;
      return json({
        ok: true, kwh, code, kwh_alt: Number(row.kwh_alt ?? row.kwh),
        code_alt: (patch.code_alt as string) ?? row.code_alt ?? null, differenz: diff, warnung,
      });
    }

    if (b.aktion !== "erfassen") return json({ fehler: "Unbekannte Aktion" }, 400);

    const code = norm(b.code);
    if (!/^\d{6,14}$/.test(code)) return json({ fehler: "Ungültige Etikettennummer" }, 400);
    const kwh = Number(b.kwh);
    if (!isFinite(kwh) || kwh < 0) return json({ fehler: "Ungültiger Zählerstand" }, 400);
    const pn = norm(b.projektnummer);
    if (!pn) return json({ fehler: "Projektnummer fehlt" }, 400);
    const modus = norm(b.modus);
    if (modus !== "aufbau" && modus !== "abbau") return json({ fehler: "Modus ungültig" }, 400);

    // Fachliche Prüfungen — gelten NUR hier, nicht für Torrek
    const { data: vorhanden } = await db.from("scan_erfassung")
      .select("local_id, modus, kwh")
      .eq("projektnummer", pn).eq("code", code);

    const hatAufbau = (vorhanden ?? []).find((r) => r.modus === "aufbau");
    const hatAbbau = (vorhanden ?? []).find((r) => r.modus === "abbau");

    if (modus === "aufbau" && hatAufbau) {
      return json({ ok: true, doppelt: true, hinweis: "War schon erfasst." });
    }
    if (modus === "abbau" && !hatAufbau) {
      return json({ fehler: "Für dieses Gerät gibt es in diesem Projekt keinen Aufbau." }, 409);
    }
    if (modus === "abbau" && hatAbbau) {
      return json({ ok: true, doppelt: true, hinweis: "War schon erfasst." });
    }

    const local_id = norm(b.local_id) || crypto.randomUUID();
    const foto = b.foto ? await fotoAblegen(b.foto, `${pn.replace(/\W/g, "")}/${code}/${modus}.jpg`) : null;

    const { error } = await db.from("scan_erfassung").upsert({
      local_id, projektnummer: pn, mieter: norm(b.mieter) || null,
      code, typ_id: norm(b.typ_id) || null, modus, kwh, foto_ref: foto,
      standort: norm(b.standort) || null,
      notiz: norm(b.notiz) || null,
    }, { onConflict: "local_id" });
    if (error) throw new Error(error.message);

    const diff = modus === "abbau" && hatAufbau
      ? +(kwh - Number(hatAufbau.kwh)).toFixed(2)
      : null;

    return json({
      ok: true, local_id, differenz: diff,
      warnung: diff != null && diff < 0
        ? "Differenz negativ — Zähler übergelaufen oder vertippt." : null,
    });
  } catch (e) {
    return json({ fehler: String(e?.message ?? e) }, 500);
  }
});
