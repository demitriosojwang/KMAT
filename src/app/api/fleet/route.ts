import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildRouteLine,
  haversineDistance,
  isOffRoute,
  findCurrentStop,
  estimateETA,
  type RouteStopGPS,
} from "@/lib/gps-intelligence";

// Same route stops as in /api/gps — in production this would come from DB
const ROUTE_STOPS: RouteStopGPS[] = [
  { lat: -4.0753, lng: 39.6672, stopName: "Likoni Ferry", order: 1 },
  { lat: -4.0710, lng: 39.6740, stopName: "Shelly Beach", order: 2 },
  { lat: -4.0550, lng: 39.6850, stopName: "Kongowea", order: 3 },
  { lat: -4.0450, lng: 39.7000, stopName: "Nyali Bridge", order: 4 },
  { lat: -4.0380, lng: 39.7100, stopName: "Mamba Village", order: 5 },
  { lat: -4.0300, lng: 39.7200, stopName: "Citizen TV Roundabout", order: 6 },
  { lat: -4.0250, lng: 39.7280, stopName: "Nyali Centre", order: 7 },
  { lat: -4.0180, lng: 39.7350, stopName: "Bamburi", order: 8 },
  { lat: -4.0050, lng: 39.7450, stopName: "Mtwapa", order: 9 },
  { lat: -4.0500, lng: 39.6700, stopName: "Mombasa CBD (Tusker)", order: 10 },
];

const ROUTE_LINE = buildRouteLine(ROUTE_STOPS);

export async function GET() {
  try {
    // Get all buses with their live state + active trip
    const buses = await db.bus.findMany({
      include: {
        route: { include: { stops: { orderBy: { order: "asc" } } } },
        sacco: true,
        trips: {
          where: { status: "active" },
          take: 1,
          orderBy: { startTime: "desc" },
        },
      },
    });

    const fleet = buses.map((bus) => {
      const pos = bus.lastLat && bus.lastLng
        ? { lat: bus.lastLat, lng: bus.lastLng }
        : null;

      let intelligence: any = null;
      if (pos) {
        const offRouteInfo = isOffRoute(pos, ROUTE_LINE);
        const atStopIdx = findCurrentStop(pos, ROUTE_STOPS);
        const activeTrip = bus.trips[0];
        const currentStopIndex = activeTrip?.currentStopIndex ?? 0;

        intelligence = {
          atStopIndex: atStopIdx,
          atStopName: atStopIdx >= 0 ? ROUTE_STOPS[atStopIdx].stopName : null,
          isOffRoute: offRouteInfo.offRoute,
          offRouteDistance: Math.round(offRouteInfo.distance),
          currentStopIndex,
          etaToNextStop: estimateETA(
            pos,
            currentStopIndex,
            currentStopIndex + 1,
            ROUTE_STOPS,
            bus.lastSpeed ?? 0
          ),
        };
      }

      return {
        id: bus.id,
        name: bus.name,
        registrationNumber: bus.registrationNumber,
        saccoName: bus.sacco?.name,
        routeName: bus.route?.name,
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
      fleet,
      stats,
      routeStops: ROUTE_STOPS,
      routeLine: ROUTE_LINE,
    });
  } catch (error) {
    console.error("Error fetching fleet:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
