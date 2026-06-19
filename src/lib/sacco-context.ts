/**
 * SACCO context helper.
 *
 * Resolution order:
 *   1. NextAuth session (JWT) — populated when an owner signs in via
 *      /api/auth/[...nextauth]. This is the production path.
 *   2. `?ownerId=` query param or `x-owner-id` header — kept around so
 *      that automated tests / scripted demos can impersonate an owner
 *      without going through the sign-in flow.
 *   3. First Owner row — last-resort fallback for dev/seed.
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
  } catch (e) {
    // Session lookup failed — fall through to header-based path
  }

  // 2. Header / query-string override (tests + scripted demos)
  let ownerId: string | null = null;
  if (req) {
    const url = new URL(req.url, "http://x");
    ownerId = url.searchParams.get("ownerId");
    if (!ownerId) {
      ownerId = req.headers.get("x-owner-id");
    }
  }

  let owner;
  if (ownerId) {
    owner = await db.owner.findUnique({
      where: { id: ownerId },
      include: { sacco: true },
    });
  }
  // 3. Last-resort fallback: first owner (so dev still works pre-login)
  if (!owner) {
    owner = await db.owner.findFirst({
      include: { sacco: true },
    });
  }
  if (!owner) return null;

  return {
    ownerId: owner.id,
    saccoId: owner.saccoId,
    saccoName: owner.sacco.name,
    region: owner.sacco.region,
    ownerName: owner.name,
  };
}
