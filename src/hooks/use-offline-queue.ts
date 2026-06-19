'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  listQueuedPayments,
  queuePayment,
  markPaymentSynced,
  markPaymentFailed,
  type QueuedPayment,
} from '@/lib/offline-db'

/**
 * Manages the offline payment queue from the React side.
 *
 * - `queueCount` — how many payments are currently pending sync
 * - `enqueue(payment)` — add a payment to the queue
 * - `replay()` — push queued payments to /api/passengers; called both
 *   on mount (catch any leftover queue from a previous session) and
 *   whenever the browser fires the `online` event
 *
 * The actual replay POSTs are de-duped by `clientId` — if the server
 * returns 409 (already exists) we treat it as success.
 */
export function useOfflineQueue() {
  const [queueCount, setQueueCount] = useState(0)
  const [isReplaying, setIsReplaying] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const items = await listQueuedPayments()
      setQueueCount(items.length)
    } catch {
      setQueueCount(0)
    }
  }, [])

  const enqueue = useCallback(
    async (payment: Omit<QueuedPayment, 'createdAt' | 'attempts' | 'status'>) => {
      const row = await queuePayment(payment)
      await refresh()
      return row
    },
    [refresh]
  )

  const replay = useCallback(async () => {
    if (isReplaying) return
    setIsReplaying(true)
    try {
      const items = await listQueuedPayments()
      for (const item of items) {
        try {
          const res = await fetch('/api/passengers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...item.payload, clientId: item.id }),
          })
          // 200 or 409 (already exists) → treat as success
          if (res.ok || res.status === 409) {
            await markPaymentSynced(item.id)
          } else {
            const data = await res.json().catch(() => ({}))
            await markPaymentFailed(item.id, data.error || `HTTP ${res.status}`)
          }
        } catch (e: any) {
          await markPaymentFailed(item.id, e?.message || 'Network error')
        }
      }
      await refresh()
    } finally {
      setIsReplaying(false)
    }
  }, [isReplaying, refresh])

  // On mount + whenever the network comes back online, attempt replay
  useEffect(() => {
    refresh()
    const handleOnline = () => {
      // Small delay — SWR cache might race with the freshly-restored network
      setTimeout(replay, 500)
    }
    window.addEventListener('online', handleOnline)
    // Kick off an initial replay attempt in case we landed here with a
    // leftover queue from a previous offline session.
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      replay()
    }
    return () => window.removeEventListener('online', handleOnline)
  }, [refresh, replay])

  return { queueCount, isReplaying, enqueue, replay, refresh }
}
