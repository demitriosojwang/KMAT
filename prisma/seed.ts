import { db } from "@/lib/db";
import bcrypt from "bcryptjs";

// ─── 33-seater Coaster layout ────────────────────────────────────────
// 4 rows of 2+2 = 16 in front body, plus 4 rows of 3-across = 17 in back
// (driver seat not counted). We'll just generate 33 seats with row/col.
function generate33Layout(): Array<{ number: number; row: number; col: number }> {
  const seats: Array<{ number: number; row: number; col: number }> = [];
  let n = 1;
  // Front body: 4 rows of 2+2 (with aisle between)
  for (let row = 1; row <= 4; row++) {
    seats.push({ number: n++, row, col: 1 });
    seats.push({ number: n++, row, col: 2 });
    seats.push({ number: n++, row, col: 4 });
    seats.push({ number: n++, row, col: 5 });
  }
  // Rear body: 5 rows of 5-across (1 spare col for center aisle at col 3)
  for (let row = 5; row <= 9; row++) {
    for (let col of [1, 2, 4, 5, 6]) {
      if (n > 33) break;
      seats.push({ number: n++, row, col });
    }
  }
  // Trim/pad to exactly 33
  return seats.slice(0, 33);
}

// ─── 14-seater Matatu layout ─────────────────────────────────────────
function generate14Layout(): Array<{ number: number; row: number; col: number }> {
  const seats: Array<{ number: number; row: number; col: number }> = [];
  let n = 1;
  // 4 rows of 2+2 (with aisle), then 1 row of 2 in the back
  for (let row = 1; row <= 3; row++) {
    seats.push({ number: n++, row, col: 1 });
    seats.push({ number: n++, row, col: 2 });
    seats.push({ number: n++, row, col: 4 });
    seats.push({ number: n++, row, col: 5 });
  }
  seats.push({ number: n++, row: 4, col: 1 });
  seats.push({ number: n++, row: 4, col: 2 });
  return seats; // 14 seats
}

// ─── Routes ──────────────────────────────────────────────────────────
// Each SACCO registers its own route(s) with code + stops + GPS coords.
type RouteDef = {
  name: string;
  code: string;
  region: string;
  stops: Array<{ name: string; lat: number; lng: number; isStage: boolean; fareFromOrigin: number }>;
};

const LIKONI_MOMBASA: RouteDef = {
  name: "Likoni → Mombasa CBD",
  code: "LKN-CBD",
  region: "Mombasa",
  stops: [
    { name: "Likoni Ferry", lat: -4.0753, lng: 39.6672, isStage: true, fareFromOrigin: 0 },
    { name: "Shelly Beach", lat: -4.0710, lng: 39.6740, isStage: true, fareFromOrigin: 30 },
    { name: "Kongowea", lat: -4.0550, lng: 39.6850, isStage: true, fareFromOrigin: 50 },
    { name: "Nyali Bridge", lat: -4.0450, lng: 39.7000, isStage: true, fareFromOrigin: 80 },
    { name: "Mamba Village", lat: -4.0380, lng: 39.7100, isStage: false, fareFromOrigin: 90 },
    { name: "Citizen TV Roundabout", lat: -4.0300, lng: 39.7200, isStage: true, fareFromOrigin: 100 },
    { name: "Nyali Centre", lat: -4.0250, lng: 39.7280, isStage: true, fareFromOrigin: 110 },
    { name: "Bamburi", lat: -4.0180, lng: 39.7350, isStage: true, fareFromOrigin: 130 },
    { name: "Mtwapa", lat: -4.0050, lng: 39.7450, isStage: true, fareFromOrigin: 150 },
    { name: "Mombasa CBD (Tusker)", lat: -4.0500, lng: 39.6700, isStage: true, fareFromOrigin: 120 },
  ],
};

// Nairobi Route 33: Umoja → CBD via Jogoo Road
const NAIROBI_33: RouteDef = {
  name: "Umoja Innercore → CBD",
  code: "33",
  region: "Nairobi",
  stops: [
    { name: "Umoja Innercore", lat: -1.2700, lng: 36.8900, isStage: true, fareFromOrigin: 0 },
    { name: "Umoja Market", lat: -1.2680, lng: 36.8830, isStage: true, fareFromOrigin: 20 },
    { name: "Tena", lat: -1.2640, lng: 36.8750, isStage: true, fareFromOrigin: 40 },
    { name: "Donholm", lat: -1.2600, lng: 36.8660, isStage: true, fareFromOrigin: 50 },
    { name: "Nyayo Estate", lat: -1.2560, lng: 36.8580, isStage: false, fareFromOrigin: 60 },
    { name: "Nyayo Stadium", lat: -1.2520, lng: 36.8470, isStage: true, fareFromOrigin: 70 },
    { name: "Railways", lat: -1.2900, lng: 36.8230, isStage: true, fareFromOrigin: 80 },
    { name: "CBD (Ronald Ngala)", lat: -1.2840, lng: 36.8240, isStage: true, fareFromOrigin: 80 },
  ],
};

// Nairobi Route 110: Pipeline → CBD via Mombasa Road
const NAIROBI_110: RouteDef = {
  name: "Pipeline → CBD",
  code: "110",
  region: "Nairobi",
  stops: [
    { name: "Pipeline", lat: -1.3240, lng: 36.8930, isStage: true, fareFromOrigin: 0 },
    { name: "Embakasi", lat: -1.3180, lng: 36.8900, isStage: true, fareFromOrigin: 30 },
    { name: "Saina Estate", lat: -1.3120, lng: 36.8840, isStage: false, fareFromOrigin: 40 },
    { name: "Imara Daima", lat: -1.3060, lng: 36.8790, isStage: true, fareFromOrigin: 50 },
    { name: "Capital Centre", lat: -1.2990, lng: 36.8680, isStage: true, fareFromOrigin: 60 },
    { name: "Nyayo Stadium", lat: -1.2520, lng: 36.8470, isStage: true, fareFromOrigin: 70 },
    { name: "CBD (Muthurwa)", lat: -1.2870, lng: 36.8320, isStage: true, fareFromOrigin: 80 },
  ],
};

// ─── Main ────────────────────────────────────────────────────────────
async function createSaccoWithRoutes(opts: {
  saccoName: string;
  region: string;
  code: string;
  owner: { name: string; phone: string; email: string; password: string };
  routes: RouteDef[];
  buses: Array<{
    name: string;
    reg: string;
    layoutType: "matatu_14" | "coaster_33" | "van_11";
    routeIndex: number;
  }>;
}) {
  const sacco = await db.sACCO.create({
    data: { name: opts.saccoName, region: opts.region, code: opts.code },
  });

  const passwordHash = await bcrypt.hash(opts.owner.password, 10);
  await db.owner.create({
    data: {
      name: opts.owner.name,
      phone: opts.owner.phone,
      email: opts.owner.email.toLowerCase(),
      passwordHash,
      saccoId: sacco.id,
    },
  });

  // Create routes + stops
  const routeIds: string[] = [];
  for (const r of opts.routes) {
    const route = await db.route.create({
      data: {
        name: r.name,
        code: r.code,
        region: r.region,
        saccoId: sacco.id,
        centerLat: r.stops[Math.floor(r.stops.length / 2)].lat,
        centerLng: r.stops[Math.floor(r.stops.length / 2)].lng,
      },
    });
    for (let i = 0; i < r.stops.length; i++) {
      const s = r.stops[i];
      await db.stop.create({
        data: {
          name: s.name,
          order: i + 1,
          isStage: s.isStage,
          lat: s.lat,
          lng: s.lng,
          fareFromOrigin: s.fareFromOrigin,
          routeId: route.id,
        },
      });
    }
    routeIds.push(route.id);
  }

  // Create buses
  for (const b of opts.buses) {
    const totalSeats =
      b.layoutType === "coaster_33" ? 33 :
      b.layoutType === "van_11" ? 11 : 14;

    const bus = await db.bus.create({
      data: {
        name: b.name,
        registrationNumber: b.reg,
        totalSeats,
        layoutType: b.layoutType,
        saccoid: sacco.id,
        routeId: routeIds[b.routeIndex],
      },
    });

    // Generate seats by layout
    const layout =
      b.layoutType === "coaster_33" ? generate33Layout() :
      b.layoutType === "van_11" ? generate14Layout().slice(0, 11) :
      generate14Layout();

    for (const s of layout) {
      await db.seat.create({
        data: {
          number: s.number,
          row: s.row,
          col: s.col,
          busId: bus.id,
        },
      });
    }

    // Active trip
    const trip = await db.trip.create({
      data: {
        busId: bus.id,
        currentStopIndex: 0,
        status: "active",
      },
    });

    // Seed some passengers for the demo bus only (first bus of first SACCO)
  }
  return sacco;
}

async function main() {
  // ─── SACCO 1: Likoni Express (Mombasa) ────────────────────────────
  const s1 = await createSaccoWithRoutes({
    saccoName: "Likoni Express SACCO",
    region: "Mombasa",
    code: "LKN-EXP",
    owner: {
      name: "John Mwangi",
      phone: "+254712345678",
      email: "mwangi@matatulink.co.ke",
      password: "matatu123",
    },
    routes: [LIKONI_MOMBASA],
    buses: [
      { name: "MatatuLink Demo Bus", reg: "KBA 234J", layoutType: "matatu_14", routeIndex: 0 },
      { name: "Coast Express 1", reg: "KDA 100P", layoutType: "coaster_33", routeIndex: 0 },
    ],
  });

  // ─── SACCO 2: CitiHopa (Nairobi) ──────────────────────────────────
  const s2 = await createSaccoWithRoutes({
    saccoName: "CitiHopa SACCO",
    region: "Nairobi",
    code: "CITIHOPA",
    owner: {
      name: "Grace Wanjiru",
      phone: "+254722999000",
      email: "grace@citihopa.co.ke",
      password: "nairobi123",
    },
    routes: [NAIROBI_33, NAIROBI_110],
    buses: [
      { name: "Umoja Cruiser", reg: "KDK 881X", layoutType: "matatu_14", routeIndex: 0 },
      { name: "Pipeline Coaster", reg: "KEE 778M", layoutType: "coaster_33", routeIndex: 1 },
    ],
  });

  // Add demo passengers on the original Likoni demo bus (first bus of SACCO 1)
  const demoBus = await db.bus.findFirst({
    where: { registrationNumber: "KBA 234J" },
    include: { route: { include: { stops: true } } },
  });
  if (demoBus) {
    const trip = await db.trip.findFirst({
      where: { busId: demoBus.id, status: "active" },
    });
    if (trip) {
      const demoPassengers = [
        { name: "Amina S.", seatNum: 1, boarding: "Likoni Ferry", alighting: "Nyali Bridge", fare: 80, alightingOrder: 4, payStatus: "paid", payMethod: "mpesa" },
        { name: "Brian K.", seatNum: 2, boarding: "Likoni Ferry", alighting: "Mombasa CBD (Tusker)", fare: 120, alightingOrder: 10, payStatus: "paid", payMethod: "cash" },
        { name: "Charity W.", seatNum: 3, boarding: "Likoni Ferry", alighting: "Bamburi", fare: 100, alightingOrder: 8, payStatus: "unpaid", payMethod: null },
        { name: "David M.", seatNum: 5, boarding: "Likoni Ferry", alighting: "Kongowea", fare: 50, alightingOrder: 3, payStatus: "paid", payMethod: "qr" },
        { name: "Esther N.", seatNum: 6, boarding: "Likoni Ferry", alighting: "Mtwapa", fare: 150, alightingOrder: 9, payStatus: "pending", payMethod: "mpesa" },
      ];
      for (const p of demoPassengers) {
        const seat = await db.seat.findFirst({
          where: { number: p.seatNum, busId: demoBus.id },
        });
        if (!seat) continue;
        const passenger = await db.passenger.create({
          data: {
            name: p.name,
            busId: demoBus.id,
            seatId: seat.id,
            boardingStop: p.boarding,
            alightingStop: p.alighting,
            alightingStopOrder: p.alightingOrder,
            fare: p.fare,
            paymentStatus: p.payStatus,
            paymentMethod: p.payMethod,
            tripId: trip.id,
          },
        });
        await db.seat.update({
          where: { id: seat.id },
          data: { isOccupied: true },
        });
        await db.transaction.create({
          data: {
            passengerId: passenger.id,
            amount: p.fare,
            method: p.payMethod || "cash",
            status: p.payStatus === "paid" ? "confirmed" : "pending",
            reference: `ML${Date.now()}${p.seatNum}`,
          },
        });
      }
      const totalPassengers = demoPassengers.length;
      const totalRevenue = demoPassengers
        .filter((p) => p.payStatus === "paid")
        .reduce((sum, p) => sum + p.fare, 0);
      await db.trip.update({
        where: { id: trip.id },
        data: { totalPassengers, totalRevenue },
      });
    }
  }

  console.log("✅ Seed complete — multi-SACCO");
  console.log(`  SACCO 1: ${s1.name} (${s1.code}) — Mombasa, 2 buses (14 + 33 seater)`);
  console.log(`    login: mwangi@matatulink.co.ke / matatu123`);
  console.log(`  SACCO 2: ${s2.name} (${s2.code}) — Nairobi, 2 buses, 2 routes (33, 110)`);
  console.log(`    login: grace@citihopa.co.ke / nairobi123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
