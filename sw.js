// Guarda os arquivos do app para abrir sem internet. Ao publicar uma alteração, aumente a VERSAO.
const VERSAO = 'inspecao-v14';
const ARQUIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'geo.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet.markercluster.js', 'vendor/MarkerCluster.css', 'vendor/exceljs.min.js', 'vendor/jszip.min.js', 'vendor/exifr.js', 'vendor/geotiff.bundle.js', 'vendor/proj4.js',
  'vendor/images/marker-icon.png', 'vendor/images/marker-shadow.png', 'vendor/images/layers.png',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).catch(() => {
      if (e.request.mode === 'navigate') return caches.match('index.html');
      return Response.error();
    }))
  );
});
