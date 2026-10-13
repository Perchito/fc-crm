// FC CRM service worker. Build __V__ (changes every deploy, so each deploy installs a fresh worker).
// - App files (JS/CSS/images) and the app page: network first, last good copy offline, so the app still opens.
// - API, documents and the calendar feed: never cached (customer data stays on the server).
const SHELL = 'fccrm-shell';

self.addEventListener('install', (e) => {
  self.skipWaiting();  // network-first, so taking over straight away can't serve stale code
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/manifest.json', '/img/icon-192.png', '/fc-logo-white.png']).catch(() => {})));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/cal/')) return;
  const nav = req.mode === 'navigate';
  if (nav && url.pathname !== '/' && url.pathname !== '/index.html') return;  // login / booking pages: plain network
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const res = await fetch(req);
      // signed out, / redirects to /login: hand that straight back, never store it
      if (res.ok && !res.redirected && res.type === 'basic') {
        const key = nav ? '/' : req.url;
        if (!nav) {  // keep only the newest ?v= copy of each file
          for (const old of await cache.keys()) if (new URL(old.url).pathname === url.pathname && old.url !== req.url) cache.delete(old);
        }
        cache.put(key, res.clone());
      }
      return res;
    } catch {
      return (await cache.match(nav ? '/' : req)) || Response.error();
    }
  })());
});
