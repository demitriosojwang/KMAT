import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withErrors } from "@/lib/api";

export const GET = withErrors(async () => {
  const bus = await db.bus.findFirst();
  if (!bus) return NextResponse.json({ seats: [] }, { status: 404 });

  const seats = await db.seat.findMany({
    where: { busId: bus.id },
    include: { passenger: true },
    orderBy: { number: "asc" },
  });

  return NextResponse.json({ seats });
});

export const PATCH = withErrors(async (request: Request) => {
  const { seatId, isOccupied } = await request.json();
  const seat = await db.seat.update({
    where: { id: seatId },
    data: { isOccupied },
  });
  return NextResponse.json({ seat });
});
