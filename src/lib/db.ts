import { PrismaClient } from '@prisma/client'

// ponytail: SQLite single-writer + file-based DB. Ceiling: ~50 SACCOs / ~200
// concurrent buses before write contention shows up as P2002 races on Trip
// updates. Upgrade: `prisma migrate` to Postgres + pg-bouncer, swap the
// `sqlite` provider in schema.prisma, no app-layer changes needed.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db