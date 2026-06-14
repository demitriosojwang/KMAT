import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const owner = await db.owner.findFirst({
      include: { sacco: { include: { buses: true } } },
    });

    if (!owner) return NextResponse.json({ error: "No owner found" }, { status: 404 });

    const bus = await db.bus.findFirst();
    if (!bus) return NextResponse.json({ owner }, { status: 200 });

    const activeTrip = await db.trip.findFirst({
      where: { busId: bus.id, status: "active" },
      include: {
        passengers: {
          include: { seat: true },
          orderBy: { boardedAt: "desc" },
        },
      },
    });

    const completedTrips = await db.trip.findMany({
      where: { busId: bus.id, status: "completed" },
      orderBy: { endTime: "desc" },
    });

    const allTrips = await db.trip.findMany({
      where: { busId: bus.id },
      include: { passengers: true },
      orderBy: { startTime: "desc" },
    });

    const totalRevenueAllTime = allTrips.reduce((sum, t) => sum + t.totalRevenue, 0);
    const totalPassengersAllTime = allTrips.reduce((sum, t) => sum + t.totalPassengers, 0);
    const totalTrips = allTrips.length;

    const transactions = await db.transaction.findMany({
      where: {
        passengerId: {
          in: activeTrip?.passengers.map((p) => p.id) || [],
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Revenue by method across all trips
    const allTransactions = await db.transaction.findMany({
      where: { status: "confirmed" },
    });
    const revenueByMethod: Record<string, number> = {};
    allTransactions.forEach((t) => {
      revenueByMethod[t.method] = (revenueByMethod[t.method] || 0) + t.amount;
    });

    return NextResponse.json({
      owner,
      activeTrip,
      completedTrips,
      analytics: {
        totalRevenueAllTime,
        totalPassengersAllTime,
        totalTrips,
        revenueByMethod,
        todayRevenue: activeTrip?.totalRevenue || 0,
        todayPassengers: activeTrip?.totalPassengers || 0,
      },
      transactions,
    });
  } catch (error) {
    console.error("Error fetching owner data:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
