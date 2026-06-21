import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withErrors } from "@/lib/api";

/**
 * GET /api/owners
 *
 * Lists every Owner in the system along with their SACCO. Used by the
 * demo "owner switcher" at the top of the app to simulate login.
 *
 * In production, this would be replaced by /api/auth/session and a
 * login page.
 */
export const GET = withErrors(async () => {
  const owners = await db.owner.findMany({
    include: { sacco: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    owners: owners.map((o) => ({
      id: o.id,
      name: o.name,
      phone: o.phone,
      saccoId: o.saccoId,
      saccoName: o.sacco.name,
      region: o.sacco.region,
      code: o.sacco.code,
    })),
  });
});
