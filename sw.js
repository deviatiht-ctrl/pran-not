/* =====================================================================
   PRAN NÒT - sw.js
   Service Worker PWA : mise en cache des pages/ressources statiques,
   navigation hors-ligne et déclenchement de synchronisation.
   ===================================================================== */

const CACHE_NAME = 'prannot-shell-v8';
const PRECACHE_URLS = [
  './',
  './index.html',
  './login.html',
  './onboarding.html',
  './manifest.json',
  './assets/icons/icon-nav.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/logos/logo-sans-bg-light.png',
  './assets/logos/logo-horizontal.png',
  './assets/css/variables.css',
  './assets/css/main.css',
  './assets/css/navbar.css',
  './assets/css/mobile-nav.css',
  './assets/css/components.css',
  './assets/css/admin.css',
  './assets/i18n/ht.json',
  './assets/i18n/fr.json',
  './assets/js/supabase.js',
  './assets/js/theme.js',
  './assets/js/auth.js',
  './assets/js/i18n.js',
  './assets/js/utils.js',
  './assets/js/navbar.js',
  './assets/js/pwa.js',
  './assets/js/ai.js',
  './assets/js/offline.js',
  './assets/js/srs.js',
  './assets/js/export.js',
  './assets/js/pages/login.js',
  './assets/js/pages/onboarding.js',
  './assets/js/pages/dashboard.js',
  './assets/js/pages/notes.js',
  './assets/js/pages/library.js',
  './assets/js/pages/note-capture.js',
  './assets/js/pages/note-view.js',
  './assets/js/pages/courses.js',
  './assets/js/pages/course.js',
  './assets/js/pages/syllabus.js',
  './assets/js/pages/review.js',
  './assets/js/pages/flashcards.js',
  './assets/js/pages/tests.js',
  './assets/js/pages/test-session.js',
  './assets/js/pages/assignments.js',
  './assets/js/pages/assignment.js',
  './assets/js/pages/tutor.js',
  './assets/js/pages/progress.js',
  './assets/js/pages/planner.js',
  './assets/js/pages/profile.js',
  './assets/js/pages/settings.js',
  './pages/dashboard.html',
  './pages/notes.html',
  './pages/library.html',
  './pages/note-capture.html',
  './pages/note-view.html',
  './pages/courses.html',
  './pages/course.html',
  './pages/syllabus.html',
  './pages/review.html',
  './pages/flashcards.html',
  './pages/tests.html',
  './pages/test-session.html',
  './pages/assignments.html',
  './pages/assignment.html',
  './pages/tutor.html',
  './pages/progress.html',
  './pages/planner.html',
  './pages/profile.html',
  './pages/settings.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache tolérant : n'échoue pas tout si une page est ajoutée ensuite
      await Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u)));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

async function fetchWithTimeout(input, init = {}, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Ne jamais mettre en cache les appels API / Storage Supabase
  if (url.hostname.includes('supabase.co') || url.pathname.includes('/functions/v1/')) {
    return;
  }

  // Navigations HTML : réseau d'abord (avec délai court), repli cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetchWithTimeout(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(req, { ignoreSearch: true }))
            || (await cache.match(url.pathname))
            || (await cache.match('./pages/dashboard.html'))
            || (await cache.match('./index.html'));
        })
    );
    return;
  }

  // Fichiers locaux (.js, .css, .json, .svg) : réseau d'abord sans cache périmé pour éviter tout décalage HTML/JS
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const netRes = await fetchWithTimeout(req.url, { cache: 'no-cache' });
          if (netRes && netRes.ok) {
            cache.put(req, netRes.clone());
            return netRes;
          }
          return (await cache.match(req, { ignoreSearch: true })) || netRes;
        } catch {
          const cached = await cache.match(req, { ignoreSearch: true });
          if (cached) return cached;
          throw new Error('offline_asset_unavailable');
        }
      })
    );
    return;
  }

  // Ressources CDN figées : stale-while-revalidate (économie de données mobiles)
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('fonts.')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || networkPromise;
      })
    );
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'prannot-sync') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SYNC_QUEUE' }));
      })
    );
  }
});
