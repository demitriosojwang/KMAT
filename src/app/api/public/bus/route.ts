import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withErrors } from "@/lib/api";

/**
 * GET /api/public/bus?busId=...
 *
 * Public (no auth) — returns the SAME shape as the authed /api/bus
 * endpoint (bus + active trip + transactions) so the PassengerPanel
 * can be reused unchanged on the public /passenger route.
 *
 * Required: `busId` query param. Without it returns 400.
 *
 * No SACCO scoping is needed here — the bus ID is opaque (cuid) and
 * the response contains no PII beyond what a passenger standing at a
 * stage would see anyway (seat occupancy, route, GPS).
 */
export const GET = withErrors(async (req: Request) => {
  const url = new URL(req.url);
  const busId = url.searchParams.get("busId");
  if (!busId) {
    return NextResponse.json({ error: "busId is required" }, { status: 400 });
  }

  const bus = await db.bus.findFirst({
    where: { id: busId },
    include: {
      route: {
        include: { stops: { orderBy: { order: "asc" } } },
      },
      seats: {
        include: { passenger: true },
        orderBy: { number: "asc" },
      },
      sacco: true,
    },
  });

  if (!bus) {
    return NextResponse.json({ error: "No bus found" }, { status: 404 });
  }

  const activeTrip = await db.trip.findFirst({
    where: { busId: bus.id, status: "active" },
    include: {
      passengers: {
        include: { seat: true },
        orderBy: { boardedAt: "desc" },
      },
    },
  });

  const transactions = await db.transaction.findMany({
    where: {
      passengerId: {
        in: activeTrip?.passengers.map((p) => p.id) || [],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    bus,
    trip: activeTrip,
    transactions,
  });
});
