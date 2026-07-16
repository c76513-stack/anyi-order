// ★★★ 部署時：把下面的版本號 +1（v55→v56…），並把 app.js 最上面的 APP_VERSION 改成同一個數字，存檔上傳即可 ★★★
// 只要這個數字有變，所有裝置 3 分鐘內會自動抓最新版、自動重整，不用任何人手動清快取。
const CACHE = 'anyi-v62';

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
