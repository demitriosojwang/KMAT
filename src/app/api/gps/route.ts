import { NextResponse } from "next/server";

// In-memory GPS state
interface GPSPoint {
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  timestamp: string;
  busId: string;
}

const gpsHistory: GPSPoint[] = [];
const MAX_HISTORY = 500;

// Approximate real coordinates for Likoni → Mombasa route
const ROUTE_STOPS = [
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

// Generate smooth route line between stops
function getRouteLine() {
  const line: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < ROUTE_STOPS.length - 1; i++) {
    const start = ROUTE_STOPS[i];
    const end = ROUTE_STOPS[i + 1];
    const steps = 15;
    for (let j = 0; j <= steps; j++) {
      line.push({
        lat: start.lat + (end.lat - start.lat) * (j / steps),
        lng: start.lng + (end.lng - start.lng) * (j / steps),
      });
    }
  }
  return line;
}

const ROUTE_LINE = getRouteLine();

export async function GET() {
  try {
    const lastPoint = gpsHistory.length > 0 ? gpsHistory[gpsHistory.length - 1] : null;

    return NextResponse.json({
      routeStops: ROUTE_STOPS,
      routeLine: ROUTE_LINE,
      currentLocation: lastPoint || ROUTE_STOPS[0],
      speed: lastPoint?.speed || 0,
      heading: lastPoint?.heading || 0,
      lastUpdated: lastPoint?.timestamp || new Date().toISOString(),
      historyCount: gpsHistory.length,
      gpsHistory: gpsHistory.slice(-20), // Last 20 points for trail
    });
  } catch (error) {
    console.error("Error fetching GPS data:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { lat, lng, speed, heading, busId } = await request.json();

    const point: GPSPoint = {
      lat,
      lng,
      speed: speed || 0,
      heading: heading || 0,
      timestamp: new Date().toISOString(),
      busId: busId || "unknown",
    };

    gpsHistory.push(point);
    if (gpsHistory.length > MAX_HISTORY) {
      gpsHistory.shift();
    }

    return NextResponse.json({ success: true, point });
  } catch (error) {
    console.error("Error updating GPS:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
