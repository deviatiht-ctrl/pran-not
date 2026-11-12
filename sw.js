/* =====================================================================
   PRAN NÒT - sw.js
   Service Worker PWA haute performance :
   - Pré-cache complet de l'app shell + bibliothèques cœur (offline dès l'installation)
   - Cache-First / Stale-While-Revalidate sur CSS/JS/JSON/Images/CDN (< 5 ms)
   - Navigation HTML rapide (repli cache immédiat hors-ligne ou réseau > 1.2 s)
   - Déclenchement synchronisation Background Sync
   ===================================================================== */

const CACHE_NAME = 'prannot-shell-v12';
const PRECACHE_LOCAL = [
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
  './assets/i18n/ht.json?v=20261112d',
  './assets/i18n/fr.json?v=20261112d',
  './assets/js/supabase.js',
  './assets/js/theme.js',
  './assets/js/auth.js',
  './assets/js/i18n.js',
  './assets/js/utils.js',
  './assets/js/navbar.js',
  './assets/js/notifications.js',
  './assets/js/live-transfer.js',
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
  './assets/js/pages/live-class.js',
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
  './pages/live-class.html',
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

const PRECACHE_CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js',
  'https://cdn.jsdelivr.net/npm/quill@1.3.7/dist/quill.min.js',
  'https://cdn.jsdelivr.net/npm/quill@1.3.7/dist/quill.snow.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
];

function isOnline() {
  return self.navigator?.onLine !== false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled([
        ...PRECACHE_LOCAL.map((u) => cache.add(u)),
        ...PRECACHE_CDN.map((u) =>
          fetch(u, { mode: 'cors', credentials: 'omit' }).then((res) => {
            if (res && res.ok) return cache.put(u, res);
            return null;
          })
        ),
      ]);
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

async function fetchWithTimeout(input, init = {}, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function matchCachedHtml(cache, req, pathname) {
  return (await cache.match(req, { ignoreSearch: true }))
    || (await cache.match(pathname))
    || (pathname === '/' ? await cache.match('./index.html') : null)
    || (await cache.match('./pages/dashboard.html'))
    || (await cache.match('./index.html'));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ne jamais mettre en cache les appels API / Storage / Auth / Edge Functions Supabase
  if (url.hostname.includes('supabase.co') || url.pathname.includes('/functions/v1/')) {
    return;
  }

  // 1. Navigations HTML : offline -> cache immédiat (< 5 ms), online -> timeout court 1.2 s puis cache
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      if (!isOnline()) {
        const cached = await matchCachedHtml(cache, req, url.pathname);
        if (cached) return cached;
      }
      try {
        const netRes = await fetchWithTimeout(req, {}, 1200);
        if (netRes && netRes.ok) {
          event.waitUntil(cache.put(url.pathname, netRes.clone()));
          return netRes;
        }
        const cached = await matchCachedHtml(cache, req, url.pathname);
        return cached || netRes;
      } catch {
        const cached = await matchCachedHtml(cache, req, url.pathname);
        if (cached) return cached;
        return new Response('<!DOCTYPE html><meta charset="utf-8"><title>Pran Nòt</title><body style="font-family:sans-serif;padding:24px;"><h2>Mòd san entènèt</h2><p>Paj sa a poko nan kach lokal la. Retounen sou <a href="/pages/dashboard.html">Akèy la</a>.</p></body>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 2. Fichiers locaux (.css, .js, .json, .png, .svg, .webmanifest) : Cache-First + Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = (await cache.match(req))
        || (await cache.match(req, { ignoreSearch: true }))
        || (await cache.match(url.pathname));

      if (cached) {
        if (isOnline()) {
          event.waitUntil(
            fetchWithTimeout(req.url, { cache: 'no-cache' }, 4000)
              .then((netRes) => {
                if (netRes && netRes.ok) return cache.put(req, netRes.clone());
                return null;
              })
              .catch(() => {})
          );
        }
        return cached;
      }

      if (!isOnline()) {
        return Response.error();
      }

      try {
        const netRes = await fetchWithTimeout(req, {}, 4000);
        if (netRes && netRes.ok) {
          event.waitUntil(cache.put(req, netRes.clone()));
        }
        return netRes;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // 3. CDN figés & Google Fonts : Cache-First + Stale-While-Revalidate + repli non-bloquant hors-ligne
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('fonts.')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
      if (cached) {
        if (isOnline() && url.hostname.includes('fonts.googleapis.com')) {
          event.waitUntil(
            fetchWithTimeout(req, {}, 3000)
              .then((res) => (res && res.ok ? cache.put(req, res.clone()) : null))
              .catch(() => {})
          );
        }
        return cached;
      }

      if (!isOnline()) {
        if (url.hostname === 'fonts.googleapis.com') {
          return new Response('', { status: 200, headers: { 'Content-Type': 'text/css; charset=utf-8' } });
        }
        return Response.error();
      }

      try {
        const netRes = await fetchWithTimeout(req, {}, 3500);
        if (netRes && netRes.ok) {
          event.waitUntil(cache.put(req, netRes.clone()));
        }
        return netRes;
      } catch {
        if (url.hostname === 'fonts.googleapis.com') {
          return new Response('', { status: 200, headers: { 'Content-Type': 'text/css; charset=utf-8' } });
        }
        return Response.error();
      }
    })());
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.link || './pages/dashboard.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) return client.navigate(targetUrl);
          return client;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return null;
    })
  );
});
