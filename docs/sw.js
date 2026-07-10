// Service worker : cache du shell pour un démarrage instantané et un mode
// hors-ligne (dernières données connues). Incrémenter VERSION à chaque mise
// à jour des fichiers du shell pour invalider l'ancien cache.
const VERSION = "csa-v2";
const SHELL = [
  "./",
  "index.html",
  "config.json",
  "css/app.css",
  "js/app.js",
  "js/api.js",
  "js/analysis.js",
  "js/chart.js",
  "js/store.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API CoinGecko : jamais de cache (prix en direct).
  if (url.hostname.includes("coingecko")) return;

  // Données du bot : réseau d'abord, cache en secours (mode hors-ligne).
  if (url.pathname.includes("/data/")) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Shell : cache d'abord, réseau en secours.
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(event.request).catch(() => {
          if (event.request.mode === "navigate") return caches.match("index.html");
        })
    )
  );
});
