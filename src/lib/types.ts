/**
 * Shared domain types for MatatuLink.
 *
 * These are the client-side shapes used by every panel. They mirror the
 * Prisma models but are kept loose (optionals where the API may omit
 * fields) so the panels can render partial state while fetches are
 * in flight.
 */

export interface Stop {
  id: string
  name: string
  order: number
  isStage: boolean
  routeId: string
  lat?: number | null
  lng?: number | null
  fareFromOrigin?: number | null
}

export interface Passenger {
  id: string
  name: string | null
  phone: string | null
  boardingStop: string
  alightingStop: string
  alightingStopOrder: number
  // true = passenger typed a free-text landmark the driver knows but
  // isn't on the registered route (e.g. "near Naivas")
  isCustomAlighting?: boolean
  fare: number
  paymentStatus: string
  paymentMethod: string | null
  seatId: string | null
  seat?: { id: string; number: number }
  boardedAt: string
  alightedAt: string | null
}

export interface Seat {
  id: string
  number: number
  row?: number
  col?: number
  isOccupied: boolean
  passenger: Passenger | null
  busId: string
}

export type BusLayoutType = 'matatu_14' | 'coaster_33' | 'van_11'

export interface BusData {
  id: string
  name: string
  registrationNumber: string
  totalSeats: number
  layoutType?: BusLayoutType
  route: { id: string; name: string; code?: string | null; stops: Stop[] } | null
  seats: Seat[]
  sacco: { id: string; name: string; region?: string; code?: string | null }
}

export interface TripData {
  id: string
  currentStopIndex: number
  status: string
  totalPassengers: number
  totalRevenue: number
  passengers: Passenger[]
  startTime: string
  endTime: string | null
  bus?: BusData | null
}

export interface Transaction {
  id: string
  passengerId: string
  amount: number
  method: string
  status: string
  reference: string | null
  createdAt: string
}

export interface WSNotification {
  id: string
  type: string
  message: string
  target: string
  timestamp: string
  read?: boolean
}

export interface GPSLocation {
  lat: number
  lng: number
  speed: number
  heading: number
  timestamp: string
}

export interface GPSData {
  routeStops: Array<{ lat: number; lng: number; stopName: string; order: number }>
  routeLine: Array<{ lat: number; lng: number }>
  currentLocation: GPSLocation
  speed: number
  heading: number
  lastUpdated: string
  gpsHistory: GPSLocation[]
  historyCount?: number
  // Phase 2 intelligence
  atStopIndex?: number
  atStopName?: string | null
  isOffRoute?: boolean
  offRouteDistance?: number
  offRouteThreshold?: number
  routeProgressPercent?: number
  etas?: Array<{ order: number; stopName: string; etaMinutes: number | null; distanceMeters: number }>
  lastGpsAt?: string
}
