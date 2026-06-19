/**
 * Passenger-side offline persistence layer.
 *
 * Two object stores:
 *
 *   1. `paymentQueue` — queued POST /api/passengers payloads that couldn't
 *      be sent because the passenger lost connectivity mid-flow (typical
 *      inside a matatu going through a tunnel or a Safaricom dead-zone).
 *      Each row carries a client-generated `clientId` (UUID) so the
 *      Background Sync replay can de-dupe and avoid double-charging the
 *      same M-Pesa STK Push.
 *
 *   2. `cache` — generic key/value for the last-known route + last-known
 *      GPS ping. Lets the Passenger panel render the live map + stop list
 *      even when the network is gone, with a "live data paused" banner
 *      instead of a blank screen.
 *
 * The DB is intentionally per-browser (origin-scoped). One DB instance
 * is shared across all tabs of the same passenger PWA.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface QueuedPayment {
  id: string;          // clientId — generated client-side, used for de-dupe
  payload: {
    name: string | null;
    phone: string | null;
    seatNumber: number;
    boardingStop: string;
    alightingStop: string;
    alightingStopOrder: number;
    isCustomAlighting: boolean;
    fare: number;
    paymentMethod: string;
    busId?: string;
  };
  createdAt: number;
  attempts: number;    // bumped on every replay attempt
  lastError?: string;
  status: "queued" | "syncing" | "synced" | "failed";
}

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  cachedAt: number;
  ttlMs?: number;
}

interface MatatuOfflineDB extends DBSchema {
  paymentQueue: {
    key: string;
    value: QueuedPayment;
    indexes: { "by-status": string; "by-createdAt": number };
  };
  cache: {
    key: string;
    value: CacheEntry;
  };
}

const DB_NAME = "matatulink-offline";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<MatatuOfflineDB>> | null = null;

function getDB() {
  if (typeof window === "undefined") {
    throw new Error("offline-db can only be used in the browser");
  }
  if (!dbPromise) {
    dbPromise = openDB<MatatuOfflineDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("paymentQueue")) {
          const store = db.createObjectStore("paymentQueue", { keyPath: "id" });
          store.createIndex("by-status", "status");
          store.createIndex("by-createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("cache")) {
          db.createObjectStore("cache", { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

// ---------- Payment queue ----------

export async function queuePayment(payment: Omit<QueuedPayment, "createdAt" | "attempts" | "status">): Promise<QueuedPayment> {
  const db = await getDB();
  const row: QueuedPayment = {
    ...payment,
    createdAt: Date.now(),
    attempts: 0,
    status: "queued",
  };
  await db.put("paymentQueue", row);
  return row;
}

export async function listQueuedPayments(): Promise<QueuedPayment[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("paymentQueue", "by-createdAt");
  return all.filter((p) => p.status === "queued" || p.status === "failed" || p.status === "syncing");
}

export async function markPaymentSynced(id: string): Promise<void> {
  const db = await getDB();
  const existing = await db.get("paymentQueue", id);
  if (existing) {
    await db.put("paymentQueue", { ...existing, status: "synced", lastError: undefined });
    // Purge synced rows older than 24h to keep the DB tidy
    await db.delete("paymentQueue", id);
  }
}

export async function markPaymentFailed(id: string, error: string): Promise<void> {
  const db = await getDB();
  const existing = await db.get("paymentQueue", id);
  if (existing) {
    await db.put("paymentQueue", {
      ...existing,
      status: "failed",
      attempts: existing.attempts + 1,
      lastError: error,
    });
  }
}

export async function clearSyncedPayments(): Promise<void> {
  const db = await getDB();
  const all = await db.getAll("paymentQueue");
  await Promise.all(
    all.filter((p) => p.status === "synced").map((p) => db.delete("paymentQueue", p.id))
  );
}

// ---------- Generic cache ----------

export async function setCache<T>(key: string, value: T, ttlMs?: number): Promise<void> {
  const db = await getDB();
  const entry: CacheEntry<T> = { key, value, cachedAt: Date.now(), ttlMs };
  await db.put("cache", entry);
}

export async function getCache<T>(key: string): Promise<{ value: T; cachedAt: number } | null> {
  const db = await getDB();
  const entry = (await db.get("cache", key)) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.ttlMs && Date.now() - entry.cachedAt > entry.ttlMs) {
    return null; // expired
  }
  return { value: entry.value, cachedAt: entry.cachedAt };
}

export async function getCacheStale<T>(key: string): Promise<{ value: T; cachedAt: number; isStale: boolean } | null> {
  const db = await getDB();
  const entry = (await db.get("cache", key)) as CacheEntry<T> | undefined;
  if (!entry) return null;
  const isStale = entry.ttlMs ? Date.now() - entry.cachedAt > entry.ttlMs : false;
  return { value: entry.value, cachedAt: entry.cachedAt, isStale };
}
