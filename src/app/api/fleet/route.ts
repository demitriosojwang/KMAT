import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSaccoContext } from "@/lib/sacco-context";
import { withErrors } from "@/lib/api";
import {
  buildRouteLine,
  isOffRoute,
  findCurrentStop,
  estimateETA,
  type RouteStopGPS,
} from "@/lib/gps-intelligence";

/**
 * GET /api/fleet?ownerId=...
 *
 * Returns every bus in the calling owner's SACCO, each enriched with:
 *   - route stops + route line (pulled from the DB, not hardcoded)
 *   - off-route detection + geofence
 *   - ETA to the next stop based on actual speed
 *
 * Owner never sees buses from other SACCOs.
 */
export const GET = withErrors(async (req: Request) => {
  const ctx = await resolveSaccoContext(req);
  if (!ctx) {
    return NextResponse.json({ error: "No owner found" }, { status: 404 });
  }

  const buses = await db.bus.findMany({
    where: { saccoid: ctx.saccoId },
    include: {
      route: { include: { stops: { orderBy: { order: "asc" } } } },
      sacco: true,
      trips: {
        where: { status: "active" },
        take: 1,
        orderBy: { startTime: "desc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Per-bus intelligence
  const fleet = buses.map((bus) => {
    // Convert DB stops → RouteStopGPS format expected by gps-intelligence lib
    const routeStops: RouteStopGPS[] = (bus.route?.stops ?? []).map((s) => ({
      lat: s.lat ?? 0,
      lng: s.lng ?? 0,
      stopName: s.name,
      order: s.order,
    }));
    const routeLine = buildRouteLine(routeStops);

    const pos = bus.lastLat && bus.lastLng
      ? { lat: bus.lastLat, lng: bus.lastLng }
      : null;

    let intelligence: any = null;
    if (pos && routeStops.length > 0) {
      const offRouteInfo = isOffRoute(pos, routeLine);
      const atStopIdx = findCurrentStop(pos, routeStops);
      const activeTrip = bus.trips[0];
      const currentStopIndex = activeTrip?.currentStopIndex ?? 0;

      intelligence = {
        atStopIndex: atStopIdx,
        atStopName: atStopIdx >= 0 ? routeStops[atStopIdx].stopName : null,
        isOffRoute: offRouteInfo.offRoute,
        offRouteDistance: Math.round(offRouteInfo.distance),
        currentStopIndex,
        etaToNextStop: estimateETA(
          pos,
          currentStopIndex,
          currentStopIndex + 1,
          routeStops,
          bus.lastSpeed ?? 0
        ),
        routeCode: bus.route?.code ?? null,
      };
    }

    return {
      id: bus.id,
      name: bus.name,
      registrationNumber: bus.registrationNumber,
      saccoName: bus.sacco?.name,
      routeName: bus.route?.name,
      routeCode: bus.route?.code ?? null,
      layoutType: bus.layoutType,
      totalSeats: bus.totalSeats,
      position: pos,
      speed: bus.lastSpeed ?? 0,
      heading: bus.lastHeading ?? 0,
      lastGpsAt: bus.lastGpsAt?.toISOString() ?? null,
      isTracking: bus.isTracking,
      isOffRoute: bus.isOffRoute,
      activeTripId: bus.trips[0]?.id ?? null,
      totalPassengers: bus.trips[0]?.totalPassengers ?? 0,
      totalRevenue: bus.trips[0]?.totalRevenue ?? 0,
      intelligence,
      // For the Owner map: include each bus's own route line + stops
      // so the map can render the correct polyline per bus.
      routeStops,
      routeLine,
    };
  });

  // Fleet-wide stats
  const stats = {
    totalBuses: fleet.length,
    tracking: fleet.filter((b) => b.isTracking).length,
    moving: fleet.filter((b) => b.speed > 5).length,
    offRoute: fleet.filter((b) => b.isOffRoute).length,
    idle: fleet.filter((b) => !b.isTracking).length,
    totalPassengers: fleet.reduce((sum, b) => sum + b.totalPassengers, 0),
    totalRevenue: fleet.reduce((sum, b) => sum + b.totalRevenue, 0),
  };

  return NextResponse.json({
    sacco: { id: ctx.saccoId, name: ctx.saccoName, region: ctx.region },
    fleet,
    stats,
  });
});
