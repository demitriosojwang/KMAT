'use client'

/**
 * DriverPanel — the driver's crew-side surface.
 *
 * - Big "Current Stop" card with "Arrived at [next stop]" button
 * - Next-stop info card with passengers alighting at that stop
 * - GPS tracking toggle (real geolocation with simulated fallback)
 * - On-board counters + route progress bar
 * - Live notification feed
 *
 * GPS tracking posts to /api/gps every 5s. The server computes
 * geofence + off-route intelligence and broadcasts it to all crew +
 * owner panels via the `gps_update` WS event.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import {
  Navigation, MapPin, ArrowRight, Users, Armchair, Activity,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'

import type { BusData, GPSData, Passenger, Seat, Stop, TripData, WSNotification } from '@/lib/types'

interface Props {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  passengersOnBoard: Passenger[]
  gpsData: GPSData | null
  emitSocket: (event: string, data: any) => void
  notifications: WSNotification[]
  onRefresh: () => void
  fetchGpsData: () => void
}

export function DriverPanel({
  busData, tripData, stops, seats, currentStopIndex, passengersOnBoard,
  gpsData, emitSocket, notifications, onRefresh, fetchGpsData,
}: Props) {
  void tripData  // reserved for future driver-facing trip-status display

  const [advancing, setAdvancing] = useState(false)
  const [gpsTracking, setGpsTracking] = useState(false)
  const gpsIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const currentStop = stops[currentStopIndex]
  const nextStop = stops[currentStopIndex + 1]
  const alightingAtNext = passengersOnBoard.filter(
    p => p.alightingStopOrder === (currentStopIndex + 2)
  )
  const occupiedCount = seats.filter(s => s.isOccupied).length
  const emptyCount = seats.filter(s => !s.isOccupied).length

  const handleArrived = async () => {
    setAdvancing(true)
    try {
      const nextIndex = currentStopIndex + 1
      if (nextIndex >= stops.length) {
        toast.error('Already at final stop!')
        setAdvancing(false)
        return
      }

      const res = await fetch('/api/trip', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'advance_stop', stopIndex: nextIndex }),
      })
      const data = await res.json()

      if (busData?.id) {
        emitSocket('advance_stop', {
          busId: busData.id,
          stopIndex: nextIndex,
          stopName: stops[nextIndex]?.name || 'Unknown',
        })
      }

      toast.success(`📍 Arrived at ${data.stopName || stops[nextIndex]?.name}`, {
        description: `${data.alightedPassengers || 0} passenger(s) alighted`,
      })
      onRefresh()
    } catch {
      toast.error('Failed to advance stop')
    }
    setAdvancing(false)
  }

  // ─── GPS Tracking ─────────────────────────────────────────────
  // ponytail: simulated fallback coordinates when the browser doesn't
  // expose geolocation (or the user denies permission). Ceiling: never
  // matches the bus's real position, so off-route detection will fire
  // false positives. Upgrade: pull live route polyline from /api/gps
  // and snap the simulated point to it.
  const ROUTE_STOPS_GPS = [
    { lat: -4.0753, lng: 39.6672 },
    { lat: -4.0710, lng: 39.6740 },
    { lat: -4.0550, lng: 39.6850 },
    { lat: -4.0450, lng: 39.7000 },
    { lat: -4.0380, lng: 39.7100 },
    { lat: -4.0300, lng: 39.7200 },
    { lat: -4.0250, lng: 39.7280 },
    { lat: -4.0180, lng: 39.7350 },
    { lat: -4.0050, lng: 39.7450 },
    { lat: -4.0500, lng: 39.6700 },
  ]

  const sendGpsUpdate = useCallback(async (lat: number, lng: number, speed: number, heading: number) => {
    try {
      const res = await fetch('/api/gps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, speed, heading, busId: busData?.id || 'demo-bus', source: 'tablet' }),
      })
      const result = await res.json()

      if (busData?.id) {
        // Include geofence + off-route intelligence in the WS broadcast
        emitSocket('gps_update', {
          busId: busData.id,
          lat,
          lng,
          speed,
          heading,
          atStopIndex: result?.intelligence?.atStopIndex ?? -1,
          atStopName: result?.intelligence?.atStopName ?? null,
          isOffRoute: result?.intelligence?.isOffRoute ?? false,
          offRouteDistance: result?.intelligence?.offRouteDistance ?? 0,
        })
      }
      fetchGpsData()
    } catch {
      console.error('Failed to send GPS update')
    }
  }, [busData, emitSocket, fetchGpsData])

  const startGpsTracking = useCallback(() => {
    if (gpsTracking) return
    setGpsTracking(true)
    toast.success('📍 GPS tracking started')

    const sendLocation = () => {
      // Try real geolocation first
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            sendGpsUpdate(pos.coords.latitude, pos.coords.longitude, pos.coords.speed ? pos.coords.speed * 3.6 : Math.round(20 + Math.random() * 30), pos.coords.heading || Math.round(Math.random() * 360))
          },
          () => {
            // Fallback: simulated coordinates
            const idx = Math.min(currentStopIndex, ROUTE_STOPS_GPS.length - 1)
            const nextIdx = Math.min(idx + 1, ROUTE_STOPS_GPS.length - 1)
            const t = Math.random() * 0.3
            const lat = ROUTE_STOPS_GPS[idx].lat + (ROUTE_STOPS_GPS[nextIdx].lat - ROUTE_STOPS_GPS[idx].lat) * t + (Math.random() - 0.5) * 0.001
            const lng = ROUTE_STOPS_GPS[idx].lng + (ROUTE_STOPS_GPS[nextIdx].lng - ROUTE_STOPS_GPS[idx].lng) * t + (Math.random() - 0.5) * 0.001
            const speed = Math.round(20 + Math.random() * 30)
            const heading = Math.round(Math.random() * 360)
            sendGpsUpdate(lat, lng, speed, heading)
          },
          { timeout: 3000 }
        )
      } else {
        // No geolocation API: use simulated
        const idx = Math.min(currentStopIndex, ROUTE_STOPS_GPS.length - 1)
        const nextIdx = Math.min(idx + 1, ROUTE_STOPS_GPS.length - 1)
        const t = Math.random() * 0.3
        const lat = ROUTE_STOPS_GPS[idx].lat + (ROUTE_STOPS_GPS[nextIdx].lat - ROUTE_STOPS_GPS[idx].lat) * t + (Math.random() - 0.5) * 0.001
        const lng = ROUTE_STOPS_GPS[idx].lng + (ROUTE_STOPS_GPS[nextIdx].lng - ROUTE_STOPS_GPS[idx].lng) * t + (Math.random() - 0.5) * 0.001
        const speed = Math.round(20 + Math.random() * 30)
        const heading = Math.round(Math.random() * 360)
        sendGpsUpdate(lat, lng, speed, heading)
      }
    }

    // Send immediately, then every 5 seconds
    sendLocation()
    gpsIntervalRef.current = setInterval(sendLocation, 5000)
  }, [gpsTracking, currentStopIndex, sendGpsUpdate])

  const stopGpsTracking = useCallback(() => {
    setGpsTracking(false)
    if (gpsIntervalRef.current) {
      clearInterval(gpsIntervalRef.current)
      gpsIntervalRef.current = null
    }
    toast.info('GPS tracking stopped')
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (gpsIntervalRef.current) {
        clearInterval(gpsIntervalRef.current)
      }
    }
  }, [])

  return (
    <div className="space-y-6">
      {/* Current Stop - Large Display */}
      <Card className="bg-gradient-to-br from-blue-600 to-blue-800 text-white">
        <CardContent className="p-6 text-center">
          <p className="text-blue-200 text-sm font-medium mb-1">Current Stop</p>
          <h2 className="text-3xl font-bold mb-2">{currentStop?.name || 'Unknown'}</h2>
          <p className="text-blue-200 text-sm">Stop {currentStopIndex + 1} of {stops.length}</p>

          {nextStop && (
            <Button
              size="lg"
              onClick={handleArrived}
              disabled={advancing}
              className="mt-4 bg-white text-blue-800 hover:bg-blue-50 font-bold text-lg px-8"
            >
              {advancing ? 'Arriving...' : (
                <>
                  <Navigation className="w-5 h-5 mr-2" />
                  Arrived at {nextStop.name}
                </>
              )}
            </Button>
          )}
          {!nextStop && (
            <Badge className="mt-4 bg-amber-500 text-white text-sm">Final Stop</Badge>
          )}
        </CardContent>
      </Card>

      {/* Next Stop Info */}
      {nextStop && (
        <Card className="border-amber-300 bg-amber-50/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                <MapPin className="w-6 h-6 text-amber-600" />
              </div>
              <div className="flex-1">
                <p className="text-amber-600 text-sm font-medium">Next Stop</p>
                <p className="font-bold text-amber-800">{nextStop.name}</p>
                {alightingAtNext.length > 0 && (
                  <p className="text-amber-700 text-sm mt-1">
                    {alightingAtNext.length} passenger{alightingAtNext.length > 1 ? 's' : ''} alighting at {nextStop.name}
                  </p>
                )}
              </div>
              <ArrowRight className="w-5 h-5 text-amber-400" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* GPS Tracking Control */}
      <Card className="border-blue-300 bg-blue-50/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <MapPin className="w-5 h-5 text-blue-600" />
            GPS Tracking
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            {gpsTracking ? (
              <Button
                onClick={stopGpsTracking}
                variant="destructive"
                className="flex-1"
              >
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                  Stop Tracking
                </span>
              </Button>
            ) : (
              <Button
                onClick={startGpsTracking}
                className="bg-blue-600 hover:bg-blue-700 flex-1"
              >
                <Navigation className="w-4 h-4 mr-2" />
                Start GPS Tracking
              </Button>
            )}
          </div>
          {gpsData && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-white rounded-lg p-2 border">
                <p className="text-xs text-gray-500">Speed</p>
                <p className="font-bold text-blue-700">{gpsData.speed || 0} <span className="text-xs font-normal">km/h</span></p>
              </div>
              <div className="bg-white rounded-lg p-2 border">
                <p className="text-xs text-gray-500">Heading</p>
                <p className="font-bold text-blue-700">{gpsData.heading || 0}°</p>
              </div>
              <div className="bg-white rounded-lg p-2 border">
                <p className="text-xs text-gray-500">Updated</p>
                <p className="font-bold text-blue-700 text-xs">
                  {gpsData.lastUpdated ? new Date(gpsData.lastUpdated).toLocaleTimeString() : 'N/A'}
                </p>
              </div>
            </div>
          )}
          {gpsTracking && (
            <div className="flex items-center gap-2 text-xs text-blue-600">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span>Live tracking active — updating every 5s</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Counters */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <Users className="w-6 h-6 text-blue-600 mx-auto mb-1" />
            <p className="text-2xl font-bold text-blue-800">{occupiedCount}</p>
            <p className="text-xs text-gray-500">On Board</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Armchair className="w-6 h-6 text-blue-600 mx-auto mb-1" />
            <p className="text-2xl font-bold text-blue-800">{emptyCount}</p>
            <p className="text-xs text-gray-500">Empty Seats</p>
          </CardContent>
        </Card>
      </div>

      {/* Route Progress */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Navigation className="w-5 h-5 text-blue-600" />
            Route Progress
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Progress
            value={((currentStopIndex + 1) / stops.length) * 100}
            className="h-3 mb-3"
          />
          <div className="flex overflow-x-auto gap-1 pb-1">
            {stops.map((stop, i) => (
              <div
                key={stop.id}
                className={`flex flex-col items-center min-w-[48px] text-center ${
                  i <= currentStopIndex ? 'text-blue-600' : 'text-gray-400'
                }`}
              >
                <div
                  className={`w-3 h-3 rounded-full mb-1 ${
                    i < currentStopIndex ? 'bg-blue-500' :
                    i === currentStopIndex ? 'bg-blue-500 pulse-blue' :
                    'bg-gray-300'
                  }`}
                />
                <span className="text-[10px] leading-tight truncate max-w-[48px]">{stop.name.split(' ')[0]}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Live Notification Feed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-600" />
            Live Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
            {notifications.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">Waiting for updates...</p>
            ) : (
              notifications.slice(0, 15).map(n => (
                <div
                  key={n.id}
                  className={`p-2 rounded text-xs animate-in fade-in slide-in-from-left-2 duration-200 ${
                    n.type === 'payment_alert' ? 'bg-red-50 border border-red-200' :
                    n.type === 'crew_broadcast' ? 'bg-amber-50 border border-amber-200' :
                    'bg-gray-50'
                  }`}
                >
                  <p className="font-medium">{n.message}</p>
                  <p className="text-gray-400 mt-0.5">
                    {new Date(n.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
