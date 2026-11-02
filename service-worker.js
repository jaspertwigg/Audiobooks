const CACHE = "audiobooks-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./metadata.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: always try to fetch the latest version when online, and only
// fall back to the cached copy when offline. (Cache-first would leave the
// installed app stuck on an old version after updates are pushed.)
// Audiobook files themselves never go through here: they're stored in
// IndexedDB and played from blob: URLs.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    // "no-cache" makes the browser check with GitHub every time instead of
    // reusing its own saved copy (GitHub Pages lets phones keep files for up
    // to 10 minutes, which mixed old and new files right after an update).
    fetch(req, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(req, { ignoreSearch: true })
          .then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))
      )
  );
});
