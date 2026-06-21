/**
 * GPS Intelligence Library
 *
 * Provides:
 * - Haversine distance between two GPS coordinates
 * - Nearest point on route polyline
 * - Off-route detection (with configurable threshold)
 * - Geofence detection (auto-detect stop arrival from GPS)
 * - Real ETA based on actual speed + remaining route distance
 * - Route progress percentage
 */

export interface LatLng {
  lat: number
  lng: number
}

export interface RouteStopGPS extends LatLng {
  order: number
  stopName: string
}

export interface GeofenceEvent {
  type: 'stop_arrival' | 'stop_departure' | 'off_route' | 'back_on_route'
  stopIndex?: number
  stopName?: string
  distanceFromRoute?: number // meters
  message: string
  timestamp: string
}

// ─── Math helpers ───────────────────────────────────────────────────

const EARTH_RADIUS_METERS = 6_371_000

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * Haversine distance between two coordinates in meters.
 */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h))
}

/**
 * Distance from point P to line segment AB, in meters.
 * Returns the perpendicular distance if projection falls on segment,
 * otherwise distance to nearest endpoint.
 */
function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  // Convert lat/lng to a flat approximation (good enough at city scale)
  const lat0 = (a.lat + b.lat + p.lat) / 3
  const metersPerDegLat = 111_320
  const metersPerDegLng = 111_320 * Math.cos(toRad(lat0))

  const px = p.lng * metersPerDegLng
  const py = p.lat * metersPerDegLat
  const ax = a.lng * metersPerDegLng
  const ay = a.lat * metersPerDegLat
  const bx = b.lng * metersPerDegLng
  const by = b.lat * metersPerDegLat

  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy

  if (lenSq === 0) return Math.hypot(px - ax, py - ay)

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))

  const closestX = ax + t * dx
  const closestY = ay + t * dy
  return Math.hypot(px - closestX, py - closestY)
}

// ─── Route helpers ──────────────────────────────────────────────────

/**
 * Build a dense polyline from route stops by interpolating between them.
 */
export function buildRouteLine(stops: RouteStopGPS[], stepsPerSegment = 15): LatLng[] {
  const line: LatLng[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const start = stops[i]
    const end = stops[i + 1]
    for (let j = 0; j <= stepsPerSegment; j++) {
      line.push({
        lat: start.lat + (end.lat - start.lat) * (j / stepsPerSegment),
        lng: start.lng + (end.lng - start.lng) * (j / stepsPerSegment),
      })
    }
  }
  return line
}

/**
 * Compute total route distance in meters.
 */
export function routeTotalDistance(stops: RouteStopGPS[]): number {
  let total = 0
  for (let i = 0; i < stops.length - 1; i++) {
    total += haversineDistance(stops[i], stops[i + 1])
  }
  return total
}

/**
 * Distance from a GPS reading to the nearest point on the route polyline.
 * Returns { distance, segmentIndex } where segmentIndex is the index of
 * the nearest polyline segment (0-based).
 */
export function nearestRouteDistance(
  point: LatLng,
  routeLine: LatLng[]
): { distance: number; segmentIndex: number; projectedPoint: LatLng } {
  if (routeLine.length < 2) {
    return {
      distance: routeLine.length === 1 ? haversineDistance(point, routeLine[0]) : 0,
      segmentIndex: 0,
      projectedPoint: routeLine[0] || point,
    }
  }

  let minDist = Infinity
  let nearestSeg = 0
  let nearestPoint = routeLine[0]

  for (let i = 0; i < routeLine.length - 1; i++) {
    const dist = distanceToSegment(point, routeLine[i], routeLine[i + 1])
    if (dist < minDist) {
      minDist = dist
      nearestSeg = i
      // Approximate projected point as nearest endpoint (good enough for visualization)
      const distToA = haversineDistance(point, routeLine[i])
      const distToB = haversineDistance(point, routeLine[i + 1])
      nearestPoint = distToA < distToB ? routeLine[i] : routeLine[i + 1]
    }
  }

  return { distance: minDist, segmentIndex: nearestSeg, projectedPoint: nearestPoint }
}

// ─── Off-route detection ────────────────────────────────────────────

export const OFF_ROUTE_THRESHOLD_METERS = 200 // Bus must be >200m from route to count as off-route

export function isOffRoute(point: LatLng, routeLine: LatLng[], threshold = OFF_ROUTE_THRESHOLD_METERS): {
  offRoute: boolean
  distance: number
} {
  const { distance } = nearestRouteDistance(point, routeLine)
  return { offRoute: distance > threshold, distance }
}

// ─── Geofencing ─────────────────────────────────────────────────────

export const GEOFENCE_RADIUS_METERS = 80 // Bus is "at stop" if within 80m

/**
 * Find which stop (if any) the bus is currently at, based on GPS.
 * Returns the stop index, or -1 if not at any stop.
 */
export function findCurrentStop(point: LatLng, stops: RouteStopGPS[], radius = GEOFENCE_RADIUS_METERS): number {
  for (let i = 0; i < stops.length; i++) {
    const dist = haversineDistance(point, stops[i])
    if (dist <= radius) return i
  }
  return -1
}

/**
 * Find the nearest upcoming stop (at or after currentStopIndex).
 */
export function findNearestUpcomingStop(
  point: LatLng,
  stops: RouteStopGPS[],
  currentStopIndex: number
): { index: number; distance: number } {
  let nearestIdx = currentStopIndex
  let nearestDist = Infinity
  for (let i = currentStopIndex; i < stops.length; i++) {
    const d = haversineDistance(point, stops[i])
    if (d < nearestDist) {
      nearestDist = d
      nearestIdx = i
    }
  }
  return { index: nearestIdx, distance: nearestDist }
}

// ─── ETA calculation ────────────────────────────────────────────────

/**
 * Estimate ETA (minutes) to a target stop, based on actual speed and
 * remaining route distance.
 *
 * - If bus is stationary (speed < 5 km/h), falls back to average urban
 *   matatu speed of 25 km/h.
 * - Adds 30 seconds per intermediate stop (deceleration + dwell time).
 *
 * Returns ETA in minutes (rounded). Returns null if target stop is
 * before current stop or unknown.
 */
export function estimateETA(
  currentPos: LatLng,
  currentStopIndex: number,
  targetStopIndex: number,
  stops: RouteStopGPS[],
  currentSpeedKmh: number
): number | null {
  if (targetStopIndex < currentStopIndex) return null
  if (targetStopIndex === currentStopIndex) return 0

  // Distance from current position to next stop on route
  const nextStop = stops[currentStopIndex + 1]
  if (!nextStop) return null

  let totalDistance = haversineDistance(currentPos, nextStop)

  // Plus full segment distances between intermediate stops
  for (let i = currentStopIndex + 1; i < targetStopIndex; i++) {
    if (!stops[i] || !stops[i + 1]) break
    totalDistance += haversineDistance(stops[i], stops[i + 1])
  }

  // Effective speed: use actual if moving, else assume 25 km/h urban
  const effectiveSpeed = currentSpeedKmh > 5 ? currentSpeedKmh : 25
  const hours = totalDistance / 1000 / effectiveSpeed
  const minutes = hours * 60

  // Dwell time at intermediate stops (~30s each)
  const intermediateStops = targetStopIndex - currentStopIndex - 1
  const dwellMinutes = (intermediateStops * 30) / 60

  return Math.max(1, Math.round(minutes + dwellMinutes))
}

/**
 * Progress along route as percentage (0-100).
 */
export function routeProgress(
  currentPos: LatLng,
  stops: RouteStopGPS[],
  routeLine: LatLng[]
): number {
  if (routeLine.length < 2 || stops.length < 2) return 0
  const totalDist = routeTotalDistance(stops)
  if (totalDist === 0) return 0

  const { distance: distFromRoute, projectedPoint } = nearestRouteDistance(currentPos, routeLine)
  void distFromRoute

  // Distance from start of route to projected point
  let consumed = 0
  for (let i = 0; i < routeLine.length - 1; i++) {
    const segEnd = routeLine[i + 1]
    if (haversineDistance(projectedPoint, segEnd) < 5) break
    consumed += haversineDistance(routeLine[i], segEnd)
  }

  return Math.min(100, Math.max(0, Math.round((consumed / totalDist) * 100)))
}
