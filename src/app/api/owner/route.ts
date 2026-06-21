import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSaccoContext } from "@/lib/sacco-context";
import { withErrors } from "@/lib/api";

// GET /api/owner?ownerId=...
//   Resolves the calling owner, their SACCO, all buses in that SACCO
//   (with active trip + revenue stats), and all routes registered by
//   that SACCO. Owner NEVER sees data from other SACCOs.
export const GET = withErrors(async (req: Request) => {
  const ctx = await resolveSaccoContext(req);
  if (!ctx) {
    return NextResponse.json({ error: "No owner found" }, { status: 404 });
  }

  const owner = await db.owner.findUnique({
    where: { id: ctx.ownerId },
    include: { sacco: true },
  });
  if (!owner) {
    return NextResponse.json({ error: "Owner not found" }, { status: 404 });
  }

  // All buses in this SACCO only
  const buses = await db.bus.findMany({
    where: { saccoid: ctx.saccoId },
    include: {
      route: { include: { stops: { orderBy: { order: "asc" } } } },
      seats: { include: { passenger: true }, orderBy: { number: "asc" } },
      trips: {
        orderBy: { startTime: "desc" },
        include: { passengers: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // All routes registered by this SACCO
  const routes = await db.route.findMany({
    where: { saccoId: ctx.saccoId },
    include: {
      stops: { orderBy: { order: "asc" } },
      buses: { select: { id: true, name: true, registrationNumber: true, layoutType: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // ─── Aggregate analytics across ALL of the SACCO's buses ───
  const allTrips = buses.flatMap((b) => b.trips);
  const activeTrips = buses
    .map((b) => b.trips.find((t) => t.status === "active"))
    .filter(Boolean) as NonNullable<typeof buses[0]["trips"][0]>[];

  const activeTripIds = activeTrips.map((t) => t.id);
  const activePassengers = await db.passenger.findMany({
    where: { tripId: { in: activeTripIds } },
    include: { seat: true },
  });

  // All transactions for active-trip passengers
  const transactions = await db.transaction.findMany({
    where: { passengerId: { in: activePassengers.map((p) => p.id) } },
    orderBy: { createdAt: "desc" },
  });

  // Revenue by method — across ALL the SACCO's confirmed transactions
  const saccoPassengerIds = (await db.passenger.findMany({
    where: { busId: { in: buses.map((b) => b.id) } },
    select: { id: true },
  })).map((p) => p.id);

  const allSaccoTransactions = await db.transaction.findMany({
    where: {
      passengerId: { in: saccoPassengerIds },
      status: "confirmed",
    },
  });

  const revenueByMethod: Record<string, number> = {};
  allSaccoTransactions.forEach((t) => {
    revenueByMethod[t.method] = (revenueByMethod[t.method] || 0) + t.amount;
  });

  const totalRevenueAllTime = allSaccoTransactions.reduce((sum, t) => sum + t.amount, 0);
  const totalPassengersAllTime = allTrips.reduce((sum, t) => sum + t.totalPassengers, 0);
  const totalTrips = allTrips.length;

  const todayRevenue = activeTrips.reduce((sum, t) => sum + t.totalRevenue, 0);
  const todayPassengers = activeTrips.reduce((sum, t) => sum + t.totalPassengers, 0);

  // Per-bus summary
  const fleet = buses.map((b) => {
    const activeTrip = b.trips.find((t) => t.status === "active");
    return {
      id: b.id,
      name: b.name,
      registrationNumber: b.registrationNumber,
      layoutType: b.layoutType,
      totalSeats: b.totalSeats,
      routeId: b.routeId,
      routeName: b.route?.name ?? null,
      routeCode: b.route?.code ?? null,
      position: b.lastLat && b.lastLng ? { lat: b.lastLat, lng: b.lastLng } : null,
      speed: b.lastSpeed ?? 0,
      heading: b.lastHeading ?? 0,
      lastGpsAt: b.lastGpsAt?.toISOString() ?? null,
      isTracking: b.isTracking,
      isOffRoute: b.isOffRoute,
      activeTripId: activeTrip?.id ?? null,
      totalPassengers: activeTrip?.totalPassengers ?? 0,
      totalRevenue: activeTrip?.totalRevenue ?? 0,
      occupiedSeats: b.seats.filter((s) => s.isOccupied).length,
    };
  });

  // Pick the SACCO's primary bus for backward compatibility with
  // older code that expects `activeTrip`.
  const primaryBus = buses[0] ?? null;
  const activeTrip = primaryBus?.trips.find((t) => t.status === "active") ?? null;

  return NextResponse.json({
    owner,
    sacco: {
      id: ctx.saccoId,
      name: ctx.saccoName,
      region: ctx.region,
      code: owner.sacco.code,
    },
    primaryBus,
    activeTrip: activeTrip
      ? {
          ...activeTrip,
          bus: primaryBus,
          passengers: activePassengers,
        }
      : null,
    fleet,
    routes,
    transactions,
    analytics: {
      totalRevenueAllTime,
      totalPassengersAllTime,
      totalTrips,
      revenueByMethod,
      todayRevenue,
      todayPassengers,
      totalBuses: buses.length,
      totalRoutes: routes.length,
    },
  });
});
