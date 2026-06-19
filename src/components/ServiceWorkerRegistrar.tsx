'use client'

import { useServiceWorkerRegister } from '@/hooks/use-service-worker'

/**
 * Mounts once at the root of the client tree and registers the
 * service worker. Rendered inside <SessionProvider> so it picks up
 * the same React tree as the rest of the app.
 */
export function ServiceWorkerRegistrar() {
  // Register in dev too so we can verify the offline UX with Agent Browser
  useServiceWorkerRegister({ dev: true })
  return null
}
