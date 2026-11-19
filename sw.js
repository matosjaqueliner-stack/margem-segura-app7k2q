// Guarda a calculadora no celular para abrir sem internet.
// Quando tiver internet, sempre tenta pegar a versão mais nova primeiro.
var CACHE = 'margem-segura-v3';
var ARQUIVOS = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ARQUIVOS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var u = new URL(e.request.url);
  // login, código e demonstração sempre direto da internet
  if (u.origin === location.origin && /^\/(api|entrar|demo)/.test(u.pathname)) return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      if (r.ok && r.type === 'basic') {
        var copia = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copia); });
      }
      return r;
    }).catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match('index.html'); }); })
  );
});
