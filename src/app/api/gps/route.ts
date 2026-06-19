import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildRouteLine,
  haversineDistance,
  isOffRoute,
  findCurrentStop,
  findNearestUpcomingStop,
  estimateETA,
  routeProgress,
  OFF_ROUTE_THRESHOLD_METERS,
  type RouteStopGPS,
} from "@/lib/gps-intelligence";

// Approximate real coordinates for Likoni → Mombasa route
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

export async function GET(request: Request) {
  try {
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

    // Fallback to route origin if no data yet
    const currentLocation = latest ?? ROUTE_STOPS[0];
    const speed = latest?.speed ?? 0;
    const heading = latest?.heading ?? 0;
    const lastUpdated = latest?.timestamp ?? new Date().toISOString();

    // Geofence: which stop are we at?
    const atStopIdx = findCurrentStop(currentLocation, ROUTE_STOPS);
    const nearestUpcoming = findNearestUpcomingStop(currentLocation, ROUTE_STOPS, 0);

    // Off-route check
    const offRouteInfo = isOffRoute(currentLocation, ROUTE_LINE);

    // ETA to each upcoming stop
    const etas = ROUTE_STOPS.map((stop, i) => ({
      order: stop.order,
      stopName: stop.stopName,
      etaMinutes: estimateETA(currentLocation, atStopIdx >= 0 ? atStopIdx : 0, i, ROUTE_STOPS, speed),
      distanceMeters: Math.round(haversineDistance(currentLocation, stop)),
    }));

    // Route progress %
    const progress = routeProgress(currentLocation, ROUTE_STOPS, ROUTE_LINE);

    // Get recent history (either from DB or empty)
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
      // Intelligence
      atStopIndex: atStopIdx,
      atStopName: atStopIdx >= 0 ? ROUTE_STOPS[atStopIdx].stopName : null,
      nearestUpcomingStop: nearestUpcoming,
      isOffRoute: offRouteInfo.offRoute,
      offRouteDistance: Math.round(offRouteInfo.distance),
      offRouteThreshold: OFF_ROUTE_THRESHOLD_METERS,
      routeProgressPercent: progress,
      etas,
    });
  } catch (error) {
    console.error("Error fetching GPS data:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { lat, lng, speed, heading, accuracy, busId, source } = body;

    if (!busId) {
      return NextResponse.json({ error: "busId is required" }, { status: 400 });
    }

    // Compute off-route + geofence info
    const point = { lat, lng };
    const offRouteInfo = isOffRoute(point, ROUTE_LINE);
    const atStopIdx = findCurrentStop(point, ROUTE_STOPS);

    // Persist to DB
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

    // Update bus live state
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

    // Cleanup old GPS history (>24h old) to keep DB lean
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
  } catch (error) {
    console.error("Error updating GPS:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
