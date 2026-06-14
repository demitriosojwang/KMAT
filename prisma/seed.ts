import { db } from "@/lib/db";

async function main() {
  // Create SACCO
  const sacco = await db.sACCO.create({
    data: { name: "Likoni Express SACCO" },
  });

  // Create Bus
  const bus = await db.bus.create({
    data: {
      name: "MatatuLink Demo Bus",
      registrationNumber: "KBA 234J",
      totalSeats: 14,
      saccoid: sacco.id,
    },
  });

  // Create 14 Seats
  for (let i = 1; i <= 14; i++) {
    await db.seat.create({
      data: {
        number: i,
        busId: bus.id,
        isOccupied: false,
      },
    });
  }

  // Create Route with stops (Likoni - Mombasa route)
  const route = await db.route.create({
    data: {
      name: "Likoni → Mombasa CBD",
      busId: bus.id,
    },
  });

  const stops = [
    { name: "Likoni Ferry", order: 1, isStage: true },
    { name: "Shelly Beach", order: 2, isStage: true },
    { name: "Kongowea", order: 3, isStage: true },
    { name: "Nyali Bridge", order: 4, isStage: true },
    { name: "Mamba Village", order: 5, isStage: false },
    { name: "Citizen TV Roundabout", order: 6, isStage: true },
    { name: "Nyali Centre", order: 7, isStage: true },
    { name: "Bamburi", order: 8, isStage: true },
    { name: "Mtwapa", order: 9, isStage: true },
    { name: "Mombasa CBD (Tusker)", order: 10, isStage: true },
  ];

  for (const stop of stops) {
    await db.stop.create({
      data: { ...stop, routeId: route.id },
    });
  }

  // Create Owner
  await db.owner.create({
    data: {
      name: "John Mwangi",
      phone: "+254712345678",
      email: "mwangi@matatulink.co.ke",
      saccoId: sacco.id,
    },
  });

  // Create Active Trip
  const trip = await db.trip.create({
    data: {
      busId: bus.id,
      currentStopIndex: 0,
      status: "active",
      totalPassengers: 0,
      totalRevenue: 0,
    },
  });

  // Add some demo passengers
  const demoPassengers = [
    { name: "Amina S.", seatNum: 1, boarding: "Likoni Ferry", alighting: "Nyali Bridge", fare: 80, alightingOrder: 4, payStatus: "paid", payMethod: "mpesa" },
    { name: "Brian K.", seatNum: 2, boarding: "Likoni Ferry", alighting: "Mombasa CBD (Tusker)", fare: 120, alightingOrder: 10, payStatus: "paid", payMethod: "cash" },
    { name: "Charity W.", seatNum: 3, boarding: "Likoni Ferry", alighting: "Bamburi", fare: 100, alightingOrder: 8, payStatus: "unpaid", payMethod: null },
    { name: "David M.", seatNum: 5, boarding: "Likoni Ferry", alighting: "Kongowea", fare: 50, alightingOrder: 3, payStatus: "paid", payMethod: "qr" },
    { name: "Esther N.", seatNum: 6, boarding: "Likoni Ferry", alighting: "Mtwapa", fare: 150, alightingOrder: 9, payStatus: "pending", payMethod: "mpesa" },
  ];

  for (const p of demoPassengers) {
    const seat = await db.seat.findFirst({
      where: { number: p.seatNum, busId: bus.id },
    });
    if (!seat) continue;

    const passenger = await db.passenger.create({
      data: {
        name: p.name,
        busId: bus.id,
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
        status: p.payStatus === "paid" ? "confirmed" : p.payStatus === "pending" ? "pending" : "pending",
        reference: `ML${Date.now()}${p.seatNum}`,
      },
    });
  }

  // Update trip totals
  const totalPassengers = demoPassengers.length;
  const totalRevenue = demoPassengers
    .filter((p) => p.payStatus === "paid")
    .reduce((sum, p) => sum + p.fare, 0);

  await db.trip.update({
    where: { id: trip.id },
    data: { totalPassengers, totalRevenue },
  });

  console.log("Seed data created successfully!");
  console.log(`SACCO: ${sacco.name}`);
  console.log(`Bus: ${bus.name} (${bus.registrationNumber})`);
  console.log(`Route: ${route.name} with ${stops.length} stops`);
  console.log(`Trip: ${trip.id} with ${totalPassengers} demo passengers`);
  console.log(`Total revenue: KES ${totalRevenue}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
