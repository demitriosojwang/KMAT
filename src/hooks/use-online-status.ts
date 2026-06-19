'use client'

import { useEffect, useState } from 'react'

/**
 * Subscribes to the browser's online/offline events and exposes the
 * current connectivity state. Pass `true` for `simulateOffline` while
 * developing to preview the offline UX without actually pulling the
 * network — useful for Agent Browser smoke tests.
 */
export function useOnlineStatus(simulateOffline = false): boolean {
  const [online, setOnline] = useState<boolean>(true)

  useEffect(() => {
    // Initial state — navigator.onLine can be false on initial mount if
    // the browser started offline, so don't assume.
    if (!simulateOffline) {
      setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true)
    } else {
      setOnline(false)
    }

    const handleOnline = () => setOnline(!simulateOffline)
    const handleOffline = () => setOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [simulateOffline])

  return online
}
