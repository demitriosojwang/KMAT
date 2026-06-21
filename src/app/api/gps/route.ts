import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withErrors } from "@/lib/api";
import {
  buildRouteLine,
  haversineDistance,
  isOffRoute,
  findCurrentStop,
  estimateETA,
  routeProgress,
  OFF_ROUTE_THRESHOLD_METERS,
  type RouteStopGPS,
} from "@/lib/gps-intelligence";

/**
 * Helper: load a bus's route (with stops) and convert to the shape
 * expected by the gps-intelligence library. Returns null if the bus
 * has no route or its stops lack coordinates.
 */
async function loadRouteStops(busId: string): Promise<RouteStopGPS[] | null> {
  const bus = await db.bus.findUnique({
    where: { id: busId },
    include: { route: { include: { stops: { orderBy: { order: "asc" } } } } },
  });
  if (!bus?.route?.stops?.length) return null;
  // If any stop is missing coordinates, fall back to 0,0 (will not break math)
  return bus.route.stops.map((s) => ({
    lat: s.lat ?? 0,
    lng: s.lng ?? 0,
    stopName: s.name,
    order: s.order,
  }));
}

// GET /api/gps?busId=...&history=true&limit=20
export const GET = withErrors(async (request: Request) => {
  const url = new URL(request.url);
  const busId = url.searchParams.get("busId");
  const includeHistory = url.searchParams.get("history") === "true";
  const historyLimit = parseInt(url.searchParams.get("limit") || "20", 10);

  // Try to fetch the latest GPS point from DB
  let latest: { lat: number; lng: number; speed: number; heading: number; timestamp: string; isOffRoute: boolean; offRouteDistance: number } | null = null;

  if (busId) {
    const rows = await db.gPSHistory.findMany({
      where: { busId },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    if (rows.length > 0) {
      const r = rows[0];
      latest = {
        lat: r.lat,
        lng: r.lng,
        speed: r.speed,
        heading: r.heading,
        timestamp: r.createdAt.toISOString(),
        isOffRoute: r.isOffRoute,
        offRouteDistance: r.offRouteDistance ?? 0,
      };
    }
  }

  // Load bus route stops from DB (or empty array if bus has no route)
  const ROUTE_STOPS: RouteStopGPS[] = busId ? (await loadRouteStops(busId)) ?? [] : [];
  const ROUTE_LINE = buildRouteLine(ROUTE_STOPS);

  // Fallback: if no GPS data yet and no route stops, use 0,0
  const currentLocation = latest ?? ROUTE_STOPS[0] ?? { lat: 0, lng: 0 };
  const speed = latest?.speed ?? 0;
  const heading = latest?.heading ?? 0;
  const lastUpdated = latest?.timestamp ?? new Date().toISOString();

  // Geofence: which stop are we at?
  const atStopIdx = ROUTE_STOPS.length > 0 ? findCurrentStop(currentLocation, ROUTE_STOPS) : -1;

  // Off-route check
  const offRouteInfo = ROUTE_LINE.length > 0 ? isOffRoute(currentLocation, ROUTE_LINE) : { offRoute: false, distance: 0 };

  // ETA to each upcoming stop
  const etas = ROUTE_STOPS.map((stop, i) => ({
    order: stop.order,
    stopName: stop.stopName,
    etaMinutes: estimateETA(currentLocation, atStopIdx >= 0 ? atStopIdx : 0, i, ROUTE_STOPS, speed),
    distanceMeters: Math.round(haversineDistance(currentLocation, stop)),
  }));

  const progress = ROUTE_LINE.length > 0 ? routeProgress(currentLocation, ROUTE_STOPS, ROUTE_LINE) : 0;

  // Recent history
  let gpsHistory: Array<{ lat: number; lng: number; speed: number; heading: number; timestamp: string }> = [];
  let historyCount = 0;
  if (includeHistory && busId) {
    const rows = await db.gPSHistory.findMany({
      where: { busId },
      orderBy: { createdAt: "desc" },
      take: historyLimit,
    });
    historyCount = await db.gPSHistory.count({ where: { busId } });
    gpsHistory = rows
      .reverse()
      .map((r) => ({
        lat: r.lat,
        lng: r.lng,
        speed: r.speed,
        heading: r.heading,
        timestamp: r.createdAt.toISOString(),
      }));
  }

  return NextResponse.json({
    routeStops: ROUTE_STOPS,
    routeLine: ROUTE_LINE,
    currentLocation,
    speed,
    heading,
    lastUpdated,
    historyCount,
    gpsHistory,
    atStopIndex: atStopIdx,
    atStopName: atStopIdx >= 0 ? ROUTE_STOPS[atStopIdx].stopName : null,
    isOffRoute: offRouteInfo.offRoute,
    offRouteDistance: Math.round(offRouteInfo.distance),
    offRouteThreshold: OFF_ROUTE_THRESHOLD_METERS,
    routeProgressPercent: progress,
    etas,
  });
});

// POST /api/gps
// Body: { busId, lat, lng, speed, heading, accuracy, source }
export const POST = withErrors(async (request: Request) => {
  const body = await request.json();
  const { lat, lng, speed, heading, accuracy, busId, source } = body;

  if (!busId) {
    return NextResponse.json({ error: "busId is required" }, { status: 400 });
  }

  const point = { lat, lng };
  const ROUTE_STOPS = (await loadRouteStops(busId)) ?? [];
  const ROUTE_LINE = buildRouteLine(ROUTE_STOPS);
  const offRouteInfo = ROUTE_LINE.length > 0 ? isOffRoute(point, ROUTE_LINE) : { offRoute: false, distance: 0 };
  const atStopIdx = ROUTE_STOPS.length > 0 ? findCurrentStop(point, ROUTE_STOPS) : -1;

  const point_row = await db.gPSHistory.create({
    data: {
      busId,
      lat,
      lng,
      speed: speed || 0,
      heading: heading || 0,
      accuracy: accuracy ?? null,
      source: source || "tablet",
      isOffRoute: offRouteInfo.offRoute,
      offRouteDistance: offRouteInfo.distance,
    },
  });

  await db.bus.update({
    where: { id: busId },
    data: {
      lastLat: lat,
      lastLng: lng,
      lastSpeed: speed || 0,
      lastHeading: heading || 0,
      lastGpsAt: new Date(),
      isTracking: true,
      isOffRoute: offRouteInfo.offRoute,
    },
  });

  // Cleanup old GPS history (>24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await db.gPSHistory.deleteMany({
    where: { createdAt: { lt: cutoff } },
  }).catch(() => {});

  return NextResponse.json({
    success: true,
    point: {
      id: point_row.id,
      lat,
      lng,
      speed: speed || 0,
      heading: heading || 0,
      timestamp: point_row.createdAt.toISOString(),
    },
    intelligence: {
      atStopIndex: atStopIdx,
      atStopName: atStopIdx >= 0 ? ROUTE_STOPS[atStopIdx].stopName : null,
      isOffRoute: offRouteInfo.offRoute,
      offRouteDistance: Math.round(offRouteInfo.distance),
    },
  });
});
