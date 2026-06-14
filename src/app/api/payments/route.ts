import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(request: Request) {
  try {
    const { passengerId, method, amount } = await request.json();

    const passenger = await db.passenger.findUnique({
      where: { id: passengerId },
    });

    if (!passenger) {
      return NextResponse.json({ error: "Passenger not found" }, { status: 404 });
    }

    // Simulate payment processing
    await db.passenger.update({
      where: { id: passengerId },
      data: { paymentStatus: "paid", paymentMethod: method },
    });

    await db.transaction.create({
      data: {
        passengerId,
        amount: amount || passenger.fare,
        method,
        status: "confirmed",
        reference: `ML${Date.now()}`,
      },
    });

    // Update trip revenue
    const trip = await db.trip.findFirst({
      where: { id: passenger.tripId || undefined, status: "active" },
    });
    if (trip) {
      await db.trip.update({
        where: { id: trip.id },
        data: { totalRevenue: { increment: amount || passenger.fare } },
      });
    }

    return NextResponse.json({ success: true, status: "paid" });
  } catch (error) {
    console.error("Error processing payment:", error);
    return NextResponse.json({ error: "Payment failed" }, { status: 500 });
  }
}
