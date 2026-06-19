import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET /api/owners
 *
 * Lists every Owner in the system along with their SACCO. Used by the
 * demo "owner switcher" at the top of the app to simulate login.
 *
 * In production, this would be replaced by /api/auth/session and a
 * login page.
 */
export async function GET() {
  try {
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
  } catch (e) {
    console.error("Error listing owners:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
