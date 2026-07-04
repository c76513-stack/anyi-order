const CACHE = 'anyi-v54';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('script.google.com')) return;
  e.respondWith(
    fetch(e.request, { cache: 'reload' })   // 一律跳過 HTTP 快取抓最新，部署後即時生效
      .then(function(r) {
        const clone = r.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        return r;
      })
      .catch(function() { return caches.match(e.request); })
  );
});
