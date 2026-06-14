import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const trip = await db.trip.findFirst({
      where: { status: "active" },
      include: {
        passengers: {
          include: { seat: true },
          orderBy: { boardedAt: "desc" },
        },
        bus: {
          include: {
            route: { include: { stops: { orderBy: { order: "asc" } } } },
            seats: { include: { passenger: true }, orderBy: { number: "asc" } },
          },
        },
      },
    });

    if (!trip) return NextResponse.json({ error: "No active trip" }, { status: 404 });

    const transactions = await db.transaction.findMany({
      where: {
        passengerId: { in: trip.passengers.map((p) => p.id) },
      },
      orderBy: { createdAt: "desc" },
    });

    // Analytics
    const totalBoarded = trip.totalPassengers;
    const totalRevenue = trip.totalRevenue;
    const paidCount = trip.passengers.filter((p) => p.paymentStatus === "paid").length;
    const unpaidCount = trip.passengers.filter((p) => p.paymentStatus === "unpaid").length;
    const pendingCount = trip.passengers.filter((p) => p.paymentStatus === "pending").length;
    const occupiedSeats = trip.bus.seats.filter((s) => s.isOccupied).length;
    const totalSeats = trip.bus.totalSeats;
    const currentStop = trip.bus.route?.stops[trip.currentStopIndex] || null;

    // Next stop alighting
    const alightingAtNextStop = trip.passengers.filter(
      (p) => p.alightingStopOrder === trip.currentStopIndex + 1
    );

    // Revenue by payment method
    const revenueByMethod: Record<string, number> = {};
    transactions
      .filter((t) => t.status === "confirmed")
      .forEach((t) => {
        revenueByMethod[t.method] = (revenueByMethod[t.method] || 0) + t.amount;
      });

    // Revenue by stop
    const revenueByStop: Record<string, number> = {};
    trip.passengers.forEach((p) => {
      if (p.paymentStatus === "paid") {
        revenueByStop[p.alightingStop] = (revenueByStop[p.alightingStop] || 0) + p.fare;
      }
    });

    return NextResponse.json({
      trip,
      transactions,
      analytics: {
        totalBoarded,
        totalRevenue,
        paidCount,
        unpaidCount,
        pendingCount,
        occupiedSeats,
        totalSeats,
        currentStop,
        alightingAtNextStop,
        revenueByMethod,
        revenueByStop,
        occupancyRate: Math.round((occupiedSeats / totalSeats) * 100),
      },
    });
  } catch (error) {
    console.error("Error fetching trip data:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { action, stopIndex } = await request.json();

    const trip = await db.trip.findFirst({
      where: { status: "active" },
    });
    if (!trip) return NextResponse.json({ error: "No active trip" }, { status: 404 });

    if (action === "advance_stop") {
      const updated = await db.trip.update({
        where: { id: trip.id },
        data: { currentStopIndex: stopIndex },
        include: {
          bus: { include: { route: { include: { stops: { orderBy: { order: "asc" } } } } } },
        },
      });

      const stopName = updated.bus.route?.stops[stopIndex]?.name || "Unknown Stop";

      // Auto-alight passengers at this stop
      const alighting = await db.passenger.findMany({
        where: {
          tripId: trip.id,
          alightingStopOrder: stopIndex + 1,
          alightedAt: null,
        },
        include: { seat: true },
      });

      for (const p of alighting) {
        if (p.seatId) {
          await db.seat.update({
            where: { id: p.seatId },
            data: { isOccupied: false },
          });
        }
        await db.passenger.update({
          where: { id: p.id },
          data: { alightedAt: new Date() },
        });
      }

      return NextResponse.json({
        success: true,
        stopName,
        stopIndex,
        alightedPassengers: alighting.length,
      });
    }

    if (action === "end_trip") {
      await db.trip.update({
        where: { id: trip.id },
        data: { status: "completed", endTime: new Date() },
      });
      return NextResponse.json({ success: true, message: "Trip ended" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Error updating trip:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
