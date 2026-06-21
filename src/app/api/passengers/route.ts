import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withErrors } from "@/lib/api";

export const GET = withErrors(async () => {
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
});

export const POST = withErrors(async (request: Request) => {
  const data = await request.json();

  // Board a new passenger
  const {
    name, phone, seatNumber,
    boardingStop, alightingStop, alightingStopOrder,
    isCustomAlighting, fare, paymentMethod, busId,
    clientId,
  } = data;

  // Offline-replay de-dupe: if a clientId is present and a passenger
  // was already created with that clientId (e.g. the SW replayed a
  // queued payment AND the client also retried online), return the
  // existing row with 200 instead of creating a duplicate.
  if (clientId) {
    const existing = await db.passenger.findUnique({
      where: { clientId },
      include: { seat: true },
    });
    if (existing) {
      return NextResponse.json(
        { passenger: existing, deduped: true, message: "Already boarded" },
        { status: 200 }
      );
    }
  }

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
      isCustomAlighting: Boolean(isCustomAlighting),
      fare,
      paymentStatus: paymentMethod ? "paid" : "unpaid",
      paymentMethod: paymentMethod || null,
      tripId: activeTrip.id,
      clientId: clientId || null,
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
});

export const PATCH = withErrors(async (request: Request) => {
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
});
