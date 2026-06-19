import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { db } from "@/lib/db";

/**
 * GET /api/me
 *   Returns the currently-logged-in owner's identity + SACCO summary.
 *   Used by the client header to render "Signed in as …" + sign-out.
 */
export async function GET() {
  try {
    // Always list the demo owner emails — even when not authenticated —
    // so the sign-in card can render the "click to prefill" hint.
    const demoOwners = await db.owner.findMany({
      select: { id: true, name: true, email: true, sacco: { select: { name: true, region: true } } },
      orderBy: { name: "asc" },
    });

    const session: any = await getServerSession(authOptions);
    if (!session?.ownerId) {
      return NextResponse.json({
        authenticated: false,
        demoOwners: demoOwners.map((o) => ({
          email: o.email,
          name: o.name,
          saccoName: o.sacco.name,
          region: o.sacco.region,
        })),
      }, { status: 200 });
    }

    const owner = await db.owner.findUnique({
      where: { id: session.ownerId },
      include: { sacco: true },
    });
    if (!owner) {
      return NextResponse.json({
        authenticated: false,
        demoOwners: demoOwners.map((o) => ({
          email: o.email,
          name: o.name,
          saccoName: o.sacco.name,
          region: o.sacco.region,
        })),
      }, { status: 200 });
    }

    return NextResponse.json({
      authenticated: true,
      owner: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
      },
      sacco: {
        id: owner.saccoId,
        name: owner.sacco.name,
        region: owner.sacco.region,
        code: owner.sacco.code,
      },
      demoOwners: demoOwners.map((o) => ({
        email: o.email,
        name: o.name,
        saccoName: o.sacco.name,
        region: o.sacco.region,
      })),
    });
  } catch (e) {
    console.error("Error in /api/me:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
