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
      },
    });
    return NextResponse.json({ trip });
  } catch (error) {
    console.error("Error fetching trip:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.json();

    // Board a new passenger
    const { name, phone, seatNumber, boardingStop, alightingStop, alightingStopOrder, fare, paymentMethod, busId } = data;

    const bus = await db.bus.findFirst({ where: { id: busId } });
    if (!bus) return NextResponse.json({ error: "Bus not found" }, { status: 404 });

    const seat = await db.seat.findFirst({
      where: { number: seatNumber, busId: bus.id },
    });
    if (!seat) return NextResponse.json({ error: "Seat not found" }, { status: 404 });
    if (seat.isOccupied) return NextResponse.json({ error: "Seat occupied" }, { status: 400 });

    const activeTrip = await db.trip.findFirst({
      where: { busId: bus.id, status: "active" },
    });
    if (!activeTrip) return NextResponse.json({ error: "No active trip" }, { status: 404 });

    const passenger = await db.passenger.create({
      data: {
        name: name || null,
        phone: phone || null,
        seatId: seat.id,
        busId: bus.id,
        boardingStop,
        alightingStop,
        alightingStopOrder,
        fare,
        paymentStatus: paymentMethod ? "paid" : "unpaid",
        paymentMethod: paymentMethod || null,
        tripId: activeTrip.id,
      },
    });

    await db.seat.update({
      where: { id: seat.id },
      data: { isOccupied: true },
    });

    await db.trip.update({
      where: { id: activeTrip.id },
      data: {
        totalPassengers: { increment: 1 },
        totalRevenue: paymentMethod ? { increment: fare } : undefined,
      },
    });

    if (paymentMethod) {
      await db.transaction.create({
        data: {
          passengerId: passenger.id,
          amount: fare,
          method: paymentMethod,
          status: "confirmed",
          reference: `ML${Date.now()}`,
        },
      });
    }

    const fullPassenger = await db.passenger.findUnique({
      where: { id: passenger.id },
      include: { seat: true },
    });

    return NextResponse.json({ passenger: fullPassenger }, { status: 201 });
  } catch (error) {
    console.error("Error boarding passenger:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { passengerId, action } = await request.json();

    if (action === "alight") {
      const passenger = await db.passenger.findUnique({
        where: { id: passengerId },
        include: { seat: true },
      });

      if (!passenger) return NextResponse.json({ error: "Passenger not found" }, { status: 404 });

      if (passenger.paymentStatus !== "paid") {
        return NextResponse.json({ error: "Cannot alight — fare not paid!", blocked: true }, { status: 400 });
      }

      // Free the seat
      if (passenger.seatId) {
        await db.seat.update({
          where: { id: passenger.seatId },
          data: { isOccupied: false },
        });
      }

      // Mark passenger as alighted
      await db.passenger.update({
        where: { id: passengerId },
        data: { alightedAt: new Date() },
      });

      return NextResponse.json({ success: true, seatNumber: passenger.seat?.number });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Error alighting passenger:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
