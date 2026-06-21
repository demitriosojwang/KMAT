/**
 * SACCO context helper.
 *
 * Resolution order:
 *   1. NextAuth session (JWT) — populated when an owner signs in via
 *      /api/auth/[...nextauth]. This is the production path.
 *   2. `?ownerId=` query param or `x-owner-id` header — DEV/TEST ONLY.
 *      Kept around so automated tests / scripted demos can impersonate
 *      an owner without going through the sign-in flow. Gated by
 *      NODE_ENV !== 'production' so it cannot be used as an auth bypass
 *      in deployed environments.
 *   3. No further fallback. If neither path resolves an owner, return
 *      null and let the caller return 401.
 *
 * Whichever path wins, the returned context is identical: the caller
 * only sees buses / routes / passengers that belong to their SACCO.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { db } from "@/lib/db";

export interface SaccoContext {
  ownerId: string;
  saccoId: string;
  saccoName: string;
  region: string;
  ownerName: string;
}

export async function resolveSaccoContext(req?: Request): Promise<SaccoContext | null> {
  // 1. Try NextAuth session first
  try {
    const session: any = await getServerSession(authOptions);
    if (session?.ownerId && session?.saccoId) {
      const owner = await db.owner.findUnique({
        where: { id: session.ownerId },
        include: { sacco: true },
      });
      if (owner) {
        return {
          ownerId: owner.id,
          saccoId: owner.saccoId,
          saccoName: owner.sacco.name,
          region: owner.sacco.region,
          ownerName: owner.name,
        };
      }
    }
  } catch {
    // Session lookup failed — fall through to header-based path (dev only)
  }

  // 2. Header / query-string override — DEV/TEST ONLY
  if (process.env.NODE_ENV !== "production" && req) {
    const url = new URL(req.url, "http://x");
    let ownerId: string | null = url.searchParams.get("ownerId");
    if (!ownerId) {
      ownerId = req.headers.get("x-owner-id");
    }
    if (ownerId) {
      const owner = await db.owner.findUnique({
        where: { id: ownerId },
        include: { sacco: true },
      });
      if (owner) {
        return {
          ownerId: owner.id,
          saccoId: owner.saccoId,
          saccoName: owner.sacco.name,
          region: owner.sacco.region,
          ownerName: owner.name,
        };
      }
    }
  }

  // 3. No fallback. Caller should return 401.
  return null;
}
