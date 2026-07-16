/* Torrek Scan — Service Worker
   Cacht die App-Shell und die lokal gebündelten Libs, damit die App auch beim
   ersten Start ohne Netz läuft und installierbar ist. Die Edge Function wird
   NIE gecacht — Sync geht immer ans echte Netz; offline puffert die App selbst. */
const CACHE = "torrek-scan-v1";
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
  // Nur GETs anfassen. Die Sync-POSTs an die Edge Function laufen unberührt durch.
  if (r.method !== "GET") return;
  const url = new URL(r.url);
  // Fremd-Origin (z. B. Supabase) nicht cachen.
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(r).then(hit => hit || fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
