import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSaccoContext } from "@/lib/sacco-context";

// GET /api/routes?ownerId=...
//   Lists all routes owned by the calling owner's SACCO.
export async function GET(req: Request) {
  try {
    const ctx = await resolveSaccoContext(req);
    if (!ctx) {
      return NextResponse.json({ error: "No owner found" }, { status: 404 });
    }

    const routes = await db.route.findMany({
      where: { saccoId: ctx.saccoId },
      include: {
        stops: { orderBy: { order: "asc" } },
        buses: { select: { id: true, name: true, registrationNumber: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      sacco: { id: ctx.saccoId, name: ctx.saccoName, region: ctx.region },
      routes,
    });
  } catch (e) {
    console.error("Error listing routes:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

// POST /api/routes
// Body:
//   {
//     name: "Umoja → CBD",
//     code: "33",
//     region: "Nairobi",
//     stops: [
//       { name, lat, lng, isStage, fareFromOrigin },
//       ...
//     ]
//   }
export async function POST(req: Request) {
  try {
    const ctx = await resolveSaccoContext(req);
    if (!ctx) {
      return NextResponse.json({ error: "No owner found" }, { status: 404 });
    }

    const body = await req.json();
    const { name, code, region, stops } = body;

    if (!name || !Array.isArray(stops) || stops.length < 2) {
      return NextResponse.json(
        { error: "name and at least 2 stops are required" },
        { status: 400 }
      );
    }

    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (!s.name || typeof s.lat !== "number" || typeof s.lng !== "number") {
        return NextResponse.json(
          { error: `Stop #${i + 1} is missing required fields (name, lat, lng)` },
          { status: 400 }
        );
      }
    }

    const routeRegion = region || ctx.region;
    const latSum = stops.reduce((a: number, s: any) => a + s.lat, 0);
    const lngSum = stops.reduce((a: number, s: any) => a + s.lng, 0);
    const centerLat = latSum / stops.length;
    const centerLng = lngSum / stops.length;

    const route = await db.route.create({
      data: {
        name,
        code: code || null,
        region: routeRegion,
        saccoId: ctx.saccoId,
        centerLat,
        centerLng,
        stops: {
          create: stops.map((s: any, i: number) => ({
            name: s.name,
            order: i + 1,
            isStage: s.isStage ?? true,
            lat: s.lat,
            lng: s.lng,
            fareFromOrigin: s.fareFromOrigin ?? 0,
          })),
        },
      },
      include: { stops: { orderBy: { order: "asc" } } },
    });

    return NextResponse.json({
      success: true,
      route,
      sacco: { id: ctx.saccoId, name: ctx.saccoName },
    });
  } catch (e) {
    console.error("Error creating route:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
