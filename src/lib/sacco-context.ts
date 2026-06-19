/**
 * SACCO context helper.
 *
 * In production this would read a session/JWT to identify the logged-in
 * owner. For demo, we accept an optional `?ownerId=` query param or
 * `x-owner-id` header; if neither is supplied we fall back to the first
 * Owner row (so the dev experience stays frictionless).
 */
import { db } from "@/lib/db";

export interface SaccoContext {
  ownerId: string;
  saccoId: string;
  saccoName: string;
  region: string;
  ownerName: string;
}

export async function resolveSaccoContext(req?: Request): Promise<SaccoContext | null> {
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
