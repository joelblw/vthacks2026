const CACHE = 'linuxlink-shell-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/protocol.mjs', '/arch-setup.mjs', '/agent.mjs', '/console-relay.mjs', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
