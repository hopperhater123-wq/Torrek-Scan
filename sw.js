/* Torrek Scan — Service Worker
   Strategie:
   - Navigationen (HTML): NETWORK-FIRST — online immer die frische App, offline
     aus dem Cache. So kommen Updates ohne Cache-Version-Springen beim Nutzer an.
   - Statische Assets (Libs, Icon, Manifest): CACHE-FIRST — schnell und offline,
     die Dateien sind über ihren Namen versioniert.
   - Die Edge Function wird NIE gecacht — Sync geht immer ans echte Netz;
     offline puffert die App selbst (IndexedDB). */
const CACHE = "torrek-scan-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./vendor/zxing-0.21.3.min.js",
  "./vendor/xlsx-0.18.5.full.min.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;               // Sync-POSTs unberührt durchlassen
  const url = new URL(r.url);
  if (url.origin !== location.origin) return;    // Fremd-Origin (Supabase) nicht anfassen

  // HTML/Navigation: erst Netz (frisch), dann Cache (offline).
  if (r.mode === "navigate" || r.destination === "document") {
    e.respondWith(
      fetch(r).then(res => {
        const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp));
        return res;
      }).catch(() => caches.match(r).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  // Assets: erst Cache, dann Netz (und nachcachen).
  e.respondWith(
    caches.match(r).then(hit => hit || fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      return res;
    }))
  );
});
