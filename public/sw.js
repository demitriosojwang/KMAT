/* eslint-disable no-restricted-globals */
/**
 * MatatuLink Service Worker
 *
 * Strategy:
 *
 *   1. App shell (HTML, JS, CSS, fonts, Leaflet tiles) —
 *      cache-first with background revalidation. Lets a passenger open
 *      the PWA instantly even with zero connectivity.
 *
 *   2. API GETs (/api/bus, /api/gps, /api/me) —
 *      stale-while-revalidate. If the network is gone, return the last
 *      cached response so the live map + stop list still render, then
 *      silently refresh in the background when connectivity returns.
 *
 *   3. API POSTs (/api/passengers, /api/payments) —
 *      NEVER cached. If offline, return HTTP 503 with a `{ queued: true }`
 *      body so the client knows to enqueue via IndexedDB + Background
 *      Sync.
 *
 *   4. Cross-origin (Leaflet tiles, OpenStreetMap) —
 *      cache-first with a hard cap of 200 tile entries. Lets a
 *      passenger still see the map area they were last viewing even
 *      offline.
 *
 *   5. Background Sync — when the browser fires `sync` with tag
 *      `replay-queue`, drain the IndexedDB payment queue and POST each
 *      entry. De-dupe by clientId so we never double-charge M-Pesa.
 */

const SHELL_CACHE = 'matatulink-shell-v1'
const API_CACHE = 'matatulink-api-v1'
const TILES_CACHE = 'matatulink-tiles-v1'

const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.svg',
]

// API GET routes that are safe to SWR-cache (read-only passenger data)
const SWR_API_PATTERNS = [
  /\/api\/bus(\?|$)/,
  /\/api\/gps(\?|$)/,
  /\/api\/me(\?|$)/,
  /\/api\/routes(\?|$)/,
  /\/api\/seats(\?|$)/,
]

// POST routes that must NOT be cached — they need to be replayed
const POST_REPLAY_PATTERNS = [
  /\/api\/passengers$/,
  /\/api\/payments$/,
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => ![SHELL_CACHE, API_CACHE, TILES_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
      await self.clients.claim()
    })()
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Only handle same-origin + known CDNs (Leaflet). Ignore extensions, websockets.
  if (req.method === 'POST' && POST_REPLAY_PATTERNS.some((re) => re.test(url.pathname))) {
    event.respondWith(handlePostReplay(req))
    return
  }

  if (req.method !== 'GET') return

  // Cross-origin: Leaflet tiles
  if (url.hostname.endsWith('tile.openstreetmap.org') || url.hostname.endsWith('cdnjs.cloudflare.com')) {
    event.respondWith(cacheFirstWithCap(req, TILES_CACHE, 200))
    return
  }

  // Same-origin API
  if (url.pathname.startsWith('/api/') && SWR_API_PATTERNS.some((re) => re.test(url.pathname))) {
    event.respondWith(staleWhileRevalidate(req, API_CACHE))
    return
  }

  // Same-origin navigations + static assets → shell cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE))
    return
  }
})

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(req)
  if (cached) {
    // Revalidate in background
    fetch(req).then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone())
    }).catch(() => {})
    return cached
  }
  try {
    const res = await fetch(req)
    if (res.status === 200) cache.put(req, res.clone())
    return res
  } catch {
    // Navigation fallback → serve cached root so the PWA shell still loads
    if (req.mode === 'navigate') {
      const fallback = await cache.match('/')
      if (fallback) return fallback
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' })
  }
}

async function cacheFirstWithCap(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(req)
  if (cached) return cached
  try {
    const res = await fetch(req)
    if (res.status === 200) {
      // Cap the cache size — pop oldest entries when over the limit
      const keys = await cache.keys()
      if (keys.length >= maxEntries) {
        await Promise.all(keys.slice(0, keys.length - maxEntries + 1).map((k) => cache.delete(k)))
      }
      await cache.put(req, res.clone())
    }
    return res
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' })
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(req)
  const network = fetch(req)
    .then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone())
      return res
    })
    .catch(() => null)
  // Return cached immediately if present; otherwise wait for network
  return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' })
}

async function handlePostReplay(req) {
  // Are we online? If yes, just pass through.
  if (navigator.onLine) {
    try {
      return await fetch(req.clone())
    } catch (e) {
      // fall through to queue
    }
  }
  // Offline — tell the client to enqueue this POST. The client will
  // stash it in IndexedDB and register a Background Sync.
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  const body = await req.clone().text()
  const clientId = crypto.randomUUID()
  clients.forEach((c) =>
    c.postMessage({
      type: 'OFFLINE_POST_QUEUED',
      url: req.url,
      method: req.method,
      body,
      clientId,
    })
  )
  // Try to register a background sync so the queue drains automatically
  if ('sync' in self.registration) {
    try {
      await self.registration.sync.register('replay-queue')
    } catch {}
  }
  return new Response(
    JSON.stringify({ queued: true, clientId, message: 'Payment queued — will sync when back online' }),
    { status: 202, headers: { 'Content-Type': 'application/json' } }
  )
}

// ---------- Background Sync: drain the queue ----------

self.addEventListener('sync', (event) => {
  if (event.tag === 'replay-queue') {
    event.waitUntil(drainQueue())
  }
})

async function drainQueue() {
  // The SW can't directly access the IndexedDB helper module — use raw
  // IndexedDB. Same schema as offline-db.ts.
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('matatulink-offline', 1)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const tx = db.transaction('paymentQueue', 'readonly')
  const store = tx.objectStore('paymentQueue')
  const allReq = store.getAll()
  const queued = await new Promise((resolve) => {
    allReq.onsuccess = () => resolve(allReq.result || [])
  })
  for (const item of queued) {
    if (item.status === 'synced') continue
    try {
      const res = await fetch('/api/passengers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item.payload, clientId: item.id }),
      })
      if (res.ok || res.status === 409) {
        await deleteQueueRow(item.id)
      }
    } catch {
      // Leave it for the next sync tick
    }
  }
}

function deleteQueueRow(id) {
  return new Promise((resolve) => {
    const r = indexedDB.open('matatulink-offline', 1)
    r.onsuccess = () => {
      const db = r.result
      const tx = db.transaction('paymentQueue', 'readwrite')
      tx.objectStore('paymentQueue').delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    }
    r.onerror = () => resolve()
  })
}

// ---------- Periodic sync (optional, for fleet operators) ----------
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'refresh-route') {
    event.waitUntil(refreshRoute())
  }
})

async function refreshRoute() {
  const cache = await caches.open(API_CACHE)
  try {
    const res = await fetch('/api/gps')
    if (res.ok) cache.put('/api/gps', res.clone())
  } catch {}
}
