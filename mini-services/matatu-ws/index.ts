import { Server } from "socket.io";

const PORT = 3003;

const io = new Server(PORT, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// In-memory state for real-time sync
const busState: Record<string, {
  currentStopIndex: number;
  passengers: Array<{
    id: string;
    name: string | null;
    phone: string | null;
    seatNumber: number;
    boardingStop: string;
    alightingStop: string;
    alightingStopOrder: number;
    fare: number;
    paymentStatus: string;
    paymentMethod: string | null;
    boardedAt: string;
  }>;
  notifications: Array<{
    id: string;
    type: string;
    message: string;
    target: string;
    timestamp: string;
    read: boolean;
  }>;
}> = {};

function getBusState(busId: string) {
  if (!busState[busId]) {
    busState[busId] = {
      currentStopIndex: 0,
      passengers: [],
      notifications: [],
    };
  }
  return busState[busId];
}

io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Join a bus room
  socket.on("join_bus", (busId: string) => {
    socket.join(`bus_${busId}`);
    const state = getBusState(busId);
    socket.emit("bus_state", state);
    console.log(`[WS] Client ${socket.id} joined bus ${busId}`);
  });

  // Passenger boards
  socket.on(
    "passenger_boarded",
    (data: {
      busId: string;
      passenger: {
        id: string;
        name: string | null;
        phone: string | null;
        seatNumber: number;
        boardingStop: string;
        alightingStop: string;
        alightingStopOrder: number;
        fare: number;
        paymentStatus: string;
        paymentMethod: string | null;
        boardedAt: string;
      };
    }) => {
      const state = getBusState(data.busId);
      state.passengers.push(data.passenger);

      const notification = {
        id: `notif_${Date.now()}`,
        type: "passenger_boarded",
        message: `${data.passenger.name || "Passenger"} boarded — Seat ${data.passenger.seatNumber}, alighting at ${data.passenger.alightingStop}`,
        target: "all",
        timestamp: new Date().toISOString(),
        read: false,
      };
      state.notifications.unshift(notification);

      io.to(`bus_${data.busId}`).emit("passenger_boarded", data.passenger);
      io.to(`bus_${data.busId}`).emit("notification", notification);
      io.to(`bus_${data.busId}`).emit("bus_state", state);
    }
  );

  // Passenger alights
  socket.on(
    "passenger_alighted",
    (data: { busId: string; passengerId: string; seatNumber: number }) => {
      const state = getBusState(data.busId);
      state.passengers = state.passengers.filter(
        (p) => p.id !== data.passengerId
      );

      const notification = {
        id: `notif_${Date.now()}`,
        type: "passenger_alighted",
        message: `Seat ${data.seatNumber} is now free — passenger alighted`,
        target: "all",
        timestamp: new Date().toISOString(),
        read: false,
      };
      state.notifications.unshift(notification);

      io.to(`bus_${data.busId}`).emit("passenger_alighted", data);
      io.to(`bus_${data.busId}`).emit("notification", notification);
      io.to(`bus_${data.busId}`).emit("bus_state", state);
    }
  );

  // Payment update
  socket.on(
    "payment_update",
    (data: {
      busId: string;
      passengerId: string;
      status: string;
      method: string;
    }) => {
      const state = getBusState(data.busId);
      const passenger = state.passengers.find(
        (p) => p.id === data.passengerId
      );
      if (passenger) {
        passenger.paymentStatus = data.status;
        passenger.paymentMethod = data.method;
      }

      const notification = {
        id: `notif_${Date.now()}`,
        type: "payment_received",
        message: `Payment ${data.status} via ${data.method} — Passenger ${data.passengerId.slice(-4)}`,
        target: "conductor",
        timestamp: new Date().toISOString(),
        read: false,
      };
      state.notifications.unshift(notification);

      io.to(`bus_${data.busId}`).emit("payment_update", data);
      io.to(`bus_${data.busId}`).emit("notification", notification);
      io.to(`bus_${data.busId}`).emit("bus_state", state);
    }
  );

  // Driver advances to next stop
  socket.on(
    "advance_stop",
    (data: { busId: string; stopIndex: number; stopName: string }) => {
      const state = getBusState(data.busId);
      state.currentStopIndex = data.stopIndex;

      // Find passengers alighting at this stop
      const alightingPassengers = state.passengers.filter(
        (p) => p.alightingStopOrder === data.stopIndex
      );

      const notification = {
        id: `notif_${Date.now()}`,
        type: "stop_approaching",
        message: `Approaching ${data.stopName} — ${alightingPassengers.length} passenger(s) alighting`,
        target: "all",
        timestamp: new Date().toISOString(),
        read: false,
      };
      state.notifications.unshift(notification);

      io.to(`bus_${data.busId}`).emit("advance_stop", data);
      io.to(`bus_${data.busId}`).emit("notification", notification);
      io.to(`bus_${data.busId}`).emit("bus_state", state);
    }
  );

  // Conductor confirms alight
  socket.on(
    "confirm_alight",
    (data: {
      busId: string;
      passengerId: string;
      seatNumber: number;
      paid: boolean;
    }) => {
      if (data.paid) {
        const state = getBusState(data.busId);
        state.passengers = state.passengers.filter(
          (p) => p.id !== data.passengerId
        );

        const notification = {
          id: `notif_${Date.now()}`,
          type: "passenger_alighted",
          message: `Seat ${data.seatNumber} confirmed alighted — seat is now free`,
          target: "all",
          timestamp: new Date().toISOString(),
          read: false,
        };
        state.notifications.unshift(notification);

        io.to(`bus_${data.busId}`).emit("passenger_alighted", data);
        io.to(`bus_${data.busId}`).emit("notification", notification);
        io.to(`bus_${data.busId}`).emit("bus_state", state);
      } else {
        const notification = {
          id: `notif_${Date.now()}`,
          type: "payment_alert",
          message: `ALIGHT BLOCKED — Seat ${data.seatNumber} has not paid!`,
          target: "conductor",
          timestamp: new Date().toISOString(),
          read: false,
        };
        const state = getBusState(data.busId);
        state.notifications.unshift(notification);
        io.to(`bus_${data.busId}`).emit("notification", notification);
      }
    }
  );

  // Broadcast message from crew
  socket.on(
    "broadcast_message",
    (data: { busId: string; message: string; from: string }) => {
      const notification = {
        id: `notif_${Date.now()}`,
        type: "crew_broadcast",
        message: data.message,
        target: "passengers",
        timestamp: new Date().toISOString(),
        read: false,
      };
      const state = getBusState(data.busId);
      state.notifications.unshift(notification);
      io.to(`bus_${data.busId}`).emit("notification", notification);
      io.to(`bus_${data.busId}`).emit("bus_state", state);
    }
  );

  // GPS location update
  socket.on(
    "gps_update",
    (data: { busId: string; lat: number; lng: number; speed: number; heading: number }) => {
      const gpsPoint = {
        lat: data.lat,
        lng: data.lng,
        speed: data.speed,
        heading: data.heading,
        timestamp: new Date().toISOString(),
      };
      io.to(`bus_${data.busId}`).emit("gps_update", gpsPoint);
    }
  );

  socket.on("disconnect", () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

console.log(`[MatatuLink WS] WebSocket server running on port ${PORT}`);
