import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withErrors } from "@/lib/api";

/**
 * GET /api/public/buses?saccoId=...
 *
 * Public (no auth) — lists all buses in a SACCO with enough info for a
 * passenger to pick one (route, registration, live GPS stamp, seat
 * availability). Passengers use this to find a matatu without signing
 * in to a crew/admin account.
<<<<<<< HEAD
 *
 * Optional `?saccoId=` filter — if omitted, returns every bus across
 * every SACCO (still public — there is no PII here, just route + seat
 * counts).
=======
>>>>>>> 26416a0 (Restructure: passenger-first landing + crew + admin interfaces)
 */
export const GET = withErrors(async (req: Request) => {
  const url = new URL(req.url);
  const saccoId = url.searchParams.get("saccoId");

  const where = saccoId ? { saccoid: saccoId } : {};
  const buses = await db.bus.findMany({
    where,
    include: {
      sacco: { select: { id: true, name: true, region: true, code: true } },
      route: {
        select: {
          id: true,
          name: true,
          code: true,
          stops: { orderBy: { order: "asc" }, select: { id: true, name: true, order: true, fareFromOrigin: true } },
        },
      },
      seats: { select: { id: true, number: true, isOccupied: true } },
      trips: {
        where: { status: "active" },
        take: 1,
        orderBy: { startTime: "desc" },
        select: { id: true, status: true, currentStopIndex: true, startTime: true },
      },
    },
    orderBy: { registrationNumber: "asc" },
  });

  return NextResponse.json({
    buses: buses.map((b) => {
      const totalSeats = b.seats.length;
      const occupiedSeats = b.seats.filter((s) => s.isOccupied).length;
      const activeTrip = b.trips[0] ?? null;
      return {
        id: b.id,
        name: b.name,
        registrationNumber: b.registrationNumber,
        layoutType: b.layoutType,
        sacco: b.sacco,
        route: b.route,
        totalSeats,
        occupiedSeats,
        availableSeats: totalSeats - occupiedSeats,
        isTracking: b.isTracking,
        isOffRoute: b.isOffRoute,
        lastLat: b.lastLat,
        lastLng: b.lastLng,
        lastSpeed: b.lastSpeed,
        lastHeading: b.lastHeading,
        lastGpsAt: b.lastGpsAt,
        activeTrip,
      };
    }),
  });
});
