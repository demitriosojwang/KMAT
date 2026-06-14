import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const bus = await db.bus.findFirst();
    if (!bus) return NextResponse.json({ seats: [] }, { status: 404 });

    const seats = await db.seat.findMany({
      where: { busId: bus.id },
      include: { passenger: true },
      orderBy: { number: "asc" },
    });

    return NextResponse.json({ seats });
  } catch (error) {
    console.error("Error fetching seats:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { seatId, isOccupied } = await request.json();
    const seat = await db.seat.update({
      where: { id: seatId },
      data: { isOccupied },
    });
    return NextResponse.json({ seat });
  } catch (error) {
    console.error("Error updating seat:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
