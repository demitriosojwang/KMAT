import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withErrors } from "@/lib/api";

/**
 * GET /api/public/saccos
 *
 * Public (no auth) — used by the passenger landing page to render the
 * "Find your matatu" SACCO picker. Returns every SACCO with a count
 * of active buses and the region, so passengers can browse without
 * signing in.
 */
export const GET = withErrors(async () => {
  const saccos = await db.sACCO.findMany({
    include: {
      buses: {
        where: { isTracking: true },
        select: { id: true, registrationNumber: true, name: true },
      },
      _count: { select: { buses: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    saccos: saccos.map((s) => ({
      id: s.id,
      name: s.name,
      region: s.region,
      code: s.code,
      totalBuses: s._count.buses,
      liveBuses: s.buses.length,
    })),
  });
});
