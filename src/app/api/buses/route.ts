import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSaccoContext } from "@/lib/sacco-context";
import { withErrors } from "@/lib/api";

// ─── 33-seater Coaster layout (matches seed) ────────────────────────
function generate33Layout(): Array<{ number: number; row: number; col: number }> {
  const seats: Array<{ number: number; row: number; col: number }> = [];
  let n = 1;
  for (let row = 1; row <= 4; row++) {
    seats.push({ number: n++, row, col: 1 });
    seats.push({ number: n++, row, col: 2 });
    seats.push({ number: n++, row, col: 4 });
    seats.push({ number: n++, row, col: 5 });
  }
  for (let row = 5; row <= 9; row++) {
    for (let col of [1, 2, 4, 5, 6]) {
      if (n > 33) break;
      seats.push({ number: n++, row, col });
    }
  }
  return seats.slice(0, 33);
}

function generate14Layout(): Array<{ number: number; row: number; col: number }> {
  const seats: Array<{ number: number; row: number; col: number }> = [];
  let n = 1;
  for (let row = 1; row <= 3; row++) {
    seats.push({ number: n++, row, col: 1 });
    seats.push({ number: n++, row, col: 2 });
    seats.push({ number: n++, row, col: 4 });
    seats.push({ number: n++, row, col: 5 });
  }
  seats.push({ number: n++, row: 4, col: 1 });
  seats.push({ number: n++, row: 4, col: 2 });
  return seats;
}

function generate11Layout() {
  return generate14Layout().slice(0, 11);
}

// GET /api/buses?ownerId=...
//   Lists all buses owned by the calling owner's SACCO.
export const GET = withErrors(async (req: Request) => {
  const ctx = await resolveSaccoContext(req);
  if (!ctx) {
    return NextResponse.json({ error: "No owner found" }, { status: 404 });
  }

  const buses = await db.bus.findMany({
    where: { saccoid: ctx.saccoId },
    include: {
      route: { select: { id: true, name: true, code: true } },
      sacco: { select: { id: true, name: true, region: true } },
      trips: {
        where: { status: "active" },
        take: 1,
        orderBy: { startTime: "desc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    sacco: { id: ctx.saccoId, name: ctx.saccoName, region: ctx.region },
    buses,
  });
});

// POST /api/buses
// Body:
//   {
//     name: "Pipeline Coaster",
//     registrationNumber: "KEE 778M",
//     layoutType: "coaster_33" | "matatu_14" | "van_11",
//     routeId: "..." | null
//   }
export const POST = withErrors(async (req: Request) => {
  const ctx = await resolveSaccoContext(req);
  if (!ctx) {
    return NextResponse.json({ error: "No owner found" }, { status: 404 });
  }

  const body = await req.json();
  const { name, registrationNumber, layoutType, routeId } = body;

  if (!name || !registrationNumber) {
    return NextResponse.json(
      { error: "name and registrationNumber are required" },
      { status: 400 }
    );
  }

  // Validate reg number is unique
  const existing = await db.bus.findUnique({
    where: { registrationNumber },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Bus with registration ${registrationNumber} already exists` },
      { status: 409 }
    );
  }

  // Validate routeId belongs to SACCO (if provided)
  if (routeId) {
    const route = await db.route.findUnique({ where: { id: routeId } });
    if (!route || route.saccoId !== ctx.saccoId) {
      return NextResponse.json(
        { error: "Route not found or does not belong to your SACCO" },
        { status: 403 }
      );
    }
  }

  const layout =
    layoutType === "coaster_33" ? generate33Layout() :
    layoutType === "van_11" ? generate11Layout() :
    generate14Layout();
  const totalSeats = layout.length;

  const bus = await db.bus.create({
    data: {
      name,
      registrationNumber,
      layoutType: layoutType || "matatu_14",
      totalSeats,
      saccoid: ctx.saccoId,
      routeId: routeId || null,
      seats: {
        create: layout.map((s) => ({
          number: s.number,
          row: s.row,
          col: s.col,
        })),
      },
    },
    include: {
      route: { select: { id: true, name: true, code: true } },
      seats: { orderBy: { number: "asc" } },
    },
  });

  // Create an initial active trip
  const trip = await db.trip.create({
    data: { busId: bus.id, currentStopIndex: 0, status: "active" },
  });

  return NextResponse.json({ success: true, bus, tripId: trip.id });
});

// PATCH /api/buses
// Body: { busId, routeId } — re-assign a bus to a different route
export const PATCH = withErrors(async (req: Request) => {
  const ctx = await resolveSaccoContext(req);
  if (!ctx) {
    return NextResponse.json({ error: "No owner found" }, { status: 404 });
  }

  const body = await req.json();
  const { busId, routeId } = body;

  if (!busId) {
    return NextResponse.json({ error: "busId is required" }, { status: 400 });
  }

  const bus = await db.bus.findUnique({ where: { id: busId } });
  if (!bus || bus.saccoid !== ctx.saccoId) {
    return NextResponse.json(
      { error: "Bus not found or does not belong to your SACCO" },
      { status: 403 }
    );
  }

  if (routeId) {
    const route = await db.route.findUnique({ where: { id: routeId } });
    if (!route || route.saccoId !== ctx.saccoId) {
      return NextResponse.json(
        { error: "Route not found or does not belong to your SACCO" },
        { status: 403 }
      );
    }
  }

  const updated = await db.bus.update({
    where: { id: busId },
    data: { routeId: routeId || null },
    include: {
      route: { select: { id: true, name: true, code: true } },
    },
  });

  return NextResponse.json({ success: true, bus: updated });
});
