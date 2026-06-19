import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSaccoContext } from "@/lib/sacco-context";

/**
 * GET /api/bus?busId=...&ownerId=...
 *
 * - If busId is provided: returns that bus (must belong to caller's SACCO).
 * - Otherwise: returns the SACCO's primary bus (first one created),
 *   for backward compatibility with single-bus panels.
 *
 * Either way the caller is scoped to their own SACCO via resolveSaccoContext.
 */
export async function GET(req: Request) {
  try {
    const ctx = await resolveSaccoContext(req);
    if (!ctx) {
      return NextResponse.json({ error: "No owner found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const busId = url.searchParams.get("busId");

    const where = { saccoid: ctx.saccoId, ...(busId ? { id: busId } : {}) };

    const bus = await db.bus.findFirst({
      where,
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
  } catch (error) {
    console.error("Error fetching bus data:", error);
    return NextResponse.json(
      { error: "Failed to fetch bus data" },
      { status: 500 }
    );
  }
}
