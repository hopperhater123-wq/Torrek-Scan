// Torrek Scan — Service Worker
// Cache-Version bei JEDER Änderung an index.html hochzählen,
// sonst servieren installierte Geräte die alte Fassung.
const CACHE = "torrek-scan-v11";
const DATEIEN = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./vendor/zxing-0.21.3.min.js",
  "./vendor/xlsx-0.18.5.full.min.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(k => Promise.all(k.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Nur eigene Dateien aus dem Cache; Supabase-Aufrufe niemals abfangen.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const kopie = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, kopie)).catch(() => {});
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
