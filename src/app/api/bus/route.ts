import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const bus = await db.bus.findFirst({
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
