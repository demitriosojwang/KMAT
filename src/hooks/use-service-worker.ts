'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker at /sw.js on mount (production only by
 * default — pass `dev: true` to also register in development). Safe to
 * call from the root layout: no-ops on SSR.
 */
export function useServiceWorkerRegister(opts: { dev?: boolean } = {}) {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    if (process.env.NODE_ENV === 'production' || opts.dev) {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => {
          // Listen for updates and force-activate new SW versions
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing
            if (!newWorker) return
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New SW ready — take over immediately
                newWorker.postMessage({ type: 'SKIP_WAITING' })
              }
            })
          })
        })
        .catch((err) => console.warn('[MatatuLink] SW registration failed:', err))

      // When the new SW takes over, reload once so the page picks up
      // the new shell cache.
      let refreshing = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return
        refreshing = true
        window.location.reload()
      })
    }
  }, [opts.dev])
}
