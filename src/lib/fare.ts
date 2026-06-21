/**
 * Fare matrix + seat color helpers.
 *
 * Color palette: BLUE (primary) + YELLOW (accent) for MatatuLink brand.
 * State indicators (red/orange) are kept semantic — they communicate
 * seat status, not brand identity.
 */
import type { Seat } from './types'

export const PAYMENT_COLORS: Record<string, string> = {
  mpesa: '#16a34a',
  cash: '#eab308',
  qr: '#8b5cf6',
  nfc: '#f97316',
  card: '#06b6d4',
}

export const SEAT_COLORS = {
  available: 'bg-blue-50 border-blue-300 hover:bg-blue-100 cursor-pointer text-blue-700',
  occupied: 'bg-red-100 border-red-400',
  occupiedFar: 'bg-orange-100 border-orange-400',
  unpaid: 'bg-yellow-100 border-yellow-500 border-dashed',
  selected: 'bg-yellow-400 border-yellow-600 text-yellow-950 ring-2 ring-yellow-300',
}

export function getSeatColor(seat: Seat, currentStopIndex: number): string {
  if (!seat.isOccupied) return SEAT_COLORS.available
  const p = seat.passenger
  if (!p) return SEAT_COLORS.available
  if (p.paymentStatus === 'unpaid' || p.paymentStatus === 'pending') return SEAT_COLORS.unpaid
  if (p.alightingStopOrder <= currentStopIndex + 2) return SEAT_COLORS.occupied
  return SEAT_COLORS.occupiedFar
}

/**
 * Fare matrix calculator.
 *
 * Each registered Stop carries a `fareFromOrigin` (the cumulative fare
 * from the route origin to that stop, set by the SACCO owner when they
 * register the route). The fare for a boarding→alighting leg is the
 * difference between the alighting stop's fareFromOrigin and the
 * boarding stop's fareFromOrigin — i.e. the per-segment price.
 *
 * For custom (free-text) alighting points the driver knows but that
 * aren't on the route, we fall back to the fare of the LAST registered
 * stop (treating it as "to the end of the route") and let the
 * conductor adjust if needed.
 */
export function computeFare(
  stops: Array<{ name: string; order: number; fareFromOrigin?: number | null }>,
  boardingIndex: number,
  alightingStopName: string | null,
  isCustom: boolean,
): number {
  if (!stops.length) return 0
  const boardingStop = stops[boardingIndex]
  const boardingFare = boardingStop?.fareFromOrigin ?? 0

  if (isCustom || !alightingStopName) {
    // Custom drop-off: charge to the end of the route by default
    const lastStop = stops[stops.length - 1]
    const endFare = lastStop?.fareFromOrigin ?? 0
    return Math.max(0, endFare - boardingFare)
  }

  const alight = stops.find(s => s.name === alightingStopName)
  if (!alight) return 0
  const alightFare = alight.fareFromOrigin ?? 0
  return Math.max(0, alightFare - boardingFare)
}
