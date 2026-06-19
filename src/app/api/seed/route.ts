import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * POST /api/seed
 *
 * Wipes all data and re-seeds the multi-SACCO demo data set
 * (Likoni Express + CitiHopa, with 14-seater and 33-seater buses,
 *  plus Nairobi routes 33 and 110).
 */
export async function POST() {
  try {
    // Clean tables
    await db.notificationLog.deleteMany();
    await db.transaction.deleteMany();
    await db.passenger.deleteMany();
    await db.trip.deleteMany();
    await db.gPSHistory.deleteMany();
    await db.stop.deleteMany();
    await db.route.deleteMany();
    await db.seat.deleteMany();
    await db.owner.deleteMany();
    await db.bus.deleteMany();
    await db.sACCO.deleteMany();

    // Run the seed script in a child process so we don't duplicate logic
    const { stdout, stderr } = await execAsync(
      "bun run prisma/seed.ts",
      { cwd: "/home/z/my-project" }
    );
    if (stderr) console.error("[seed stderr]", stderr);
    if (stdout) console.log("[seed stdout]", stdout);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error resetting data:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
