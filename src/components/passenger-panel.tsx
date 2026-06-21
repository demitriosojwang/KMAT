'use client'

/**
 * PassengerPanel — the passenger-facing PWA surface.
 *
 * Three-step boarding flow:
 *   1. Pick a seat (visual seat map)
 *   2. Pick an alighting stop (route stops + custom drop-off)
 *   3. Pay (M-Pesa / NFC / QR / cash / card)
 *
 * Offline-aware: if the network drops mid-flow, the boarding is queued
 * in IndexedDB and replayed by the SW's Background Sync when
 * connectivity returns. De-dupe via `clientId` so a single boarding
 * never creates two passengers or two transactions.
 */
import React, { useState, useEffect } from 'react'
import { toast } from 'sonner'
import {
  Armchair, MapPin, CreditCard, CheckCircle2,
  Phone, QrCode, Banknote, Nfc,
  Navigation, ChevronRight, DollarSign,
  WifiOff, Wifi, CloudOff, RefreshCw, Hourglass,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

import { useOnlineStatus } from '@/hooks/use-online-status'
import { useOfflineQueue } from '@/hooks/use-offline-queue'
import { setCache } from '@/lib/offline-db'
import { computeFare, getSeatColor, SEAT_COLORS } from '@/lib/fare'
import type { BusData, GPSData, Seat, Stop, TripData } from '@/lib/types'
import {
  MapContainer, TileLayer, Marker, Popup, Polyline, MapRecenter,
} from '@/components/leaflet-dynamic'

interface Props {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  gpsData: GPSData | null
  emitSocket: (event: string, data: any) => void
  onRefresh: () => void
}

export function PassengerPanel({
  busData, tripData, stops, seats, currentStopIndex, gpsData, emitSocket, onRefresh,
}: Props) {
  void tripData  // reserved for future use (e.g. showing trip status to passenger)

  const [step, setStep] = useState(1)
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null)
  const [selectedStop, setSelectedStop] = useState<string>('')
  const [customStop, setCustomStop] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<string>('')
  const [mpesaPhone, setMpesaPhone] = useState('')
  const [processing, setProcessing] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [staleGps, setStaleGps] = useState(false)

  // --- Offline architecture (Phase 3) ---
  const isOnline = useOnlineStatus()
  const { queueCount, isReplaying, enqueue, replay } = useOfflineQueue()
  const [queuedLocally, setQueuedLocally] = useState(false)

  const selectedStopData = stops.find(s => s.name === selectedStop)
  // Fare matrix: fare = (alightingStop.fareFromOrigin) − (boardingStop.fareFromOrigin).
  // For custom (free-text) alighting, default to the last stop's fare.
  const usingCustom = customStop.trim().length > 0
  const fare = computeFare(stops, currentStopIndex, usingCustom ? null : selectedStop, usingCustom)

  // Cache GPS + stops in IndexedDB so they survive a navigation away
  // and back, or a closed-and-reopened PWA. The SW does its own SWR
  // for /api/gps, but having a copy in IDB also lets the UI render
  // *something* even before the SW responds on a cold start.
  useEffect(() => {
    if (gpsData) {
      setCache(`gps:${busData?.id ?? 'default'}`, gpsData, 60_000).catch(() => {})
      setStaleGps(false)
    }
  }, [gpsData, busData?.id])

  useEffect(() => {
    if (stops?.length) {
      setCache(`stops:${busData?.id ?? 'default'}`, stops, 5 * 60_000).catch(() => {})
    }
  }, [stops, busData?.id])

  // Stale-GPS detection: if we haven't seen a fresh ping in >30s, flag it
  useEffect(() => {
    if (!gpsData?.lastGpsAt) return
    const last = new Date(gpsData.lastGpsAt).getTime()
    const ageMs = Date.now() - last
    setStaleGps(ageMs > 30_000)
  }, [gpsData?.lastGpsAt])

  // Leaflet state for mini tracker (must be before any early return)
  const [miniLeafletReady, setMiniLeafletReady] = useState(false)
  const [showMiniMap, setShowMiniMap] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined' && showMiniMap && !miniLeafletReady) {
      if (!document.querySelector('link[data-leaflet]')) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'
        link.setAttribute('data-leaflet', 'true')
        document.head.appendChild(link)
      }
      import('leaflet').then((L) => {
        delete (L.Icon.Default.prototype as any)._getIconUrl
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
          iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
          shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        })
        setMiniLeafletReady(true)
      }).catch(() => {
        setTimeout(() => setShowMiniMap(false), 1000)
      })
    }
  }, [showMiniMap, miniLeafletReady])

  const handleSeatClick = (seatNum: number) => {
    const seat = seats.find(s => s.number === seatNum)
    if (seat && !seat.isOccupied) {
      setSelectedSeat(seatNum)
    }
  }

  const handlePay = async () => {
    if (!selectedSeat || !paymentMethod) return
    if (!selectedStop && !usingCustom) return
    if (paymentMethod === 'mpesa' && !mpesaPhone) {
      toast.error('Please enter your M-Pesa phone number')
      return
    }

    setProcessing(true)
    try {
      const stopOrder = usingCustom
        ? (stops[stops.length - 1]?.order ?? 1)  // custom drop-off: treat as last stop
        : (selectedStopData?.order || 1)

      // --- Offline-aware boarding ---
      // Generate a clientId so the server can de-dupe this exact boarding
      // if it arrives twice (once from SW Background Sync replay, once
      // from a client-side retry on reconnect). This is the single most
      // important line of the offline architecture: it prevents a
      // passenger from being charged twice for the same seat.
      const clientId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `ml_${Date.now()}_${Math.random().toString(36).slice(2)}`

      const payload = {
        name: null,
        phone: paymentMethod === 'mpesa' ? mpesaPhone : null,
        seatNumber: selectedSeat,
        boardingStop: stops[currentStopIndex]?.name || 'Unknown',
        alightingStop: usingCustom ? customStop.trim() : selectedStop,
        alightingStopOrder: stopOrder,
        isCustomAlighting: usingCustom,
        fare,
        paymentMethod,
        busId: busData?.id,
      }

      if (!isOnline) {
        // --- Offline path ---
        // Stash the boarding in IndexedDB. The SW's Background Sync
        // will pick it up the moment connectivity returns and POST it
        // to /api/passengers. Even if the PWA is closed before sync,
        // the queue persists — next time the passenger opens the app
        // the useOfflineQueue hook replays it on mount.
        await enqueue({ id: clientId, payload })
        setProcessing(false)
        setQueuedLocally(true)
        setConfirmed(true)
        toast.info('Queued — will sync when back online', {
          description: `Seat ${selectedSeat} reserved locally • KES ${fare}`,
          icon: <CloudOff className="w-4 h-4" />,
          duration: 5000,
        })

        // Optimistically emit WS event so crew sees the boarding
        // immediately when this tablet reconnects. Crew UI continues
        // to mark the seat as "pending sync" until the server confirms.
        if (busData?.id) {
          emitSocket('passenger_boarded', {
            busId: busData.id,
            passenger: {
              id: clientId,
              name: null,
              phone: paymentMethod === 'mpesa' ? mpesaPhone : null,
              seatNumber: selectedSeat,
              boardingStop: stops[currentStopIndex]?.name || 'Unknown',
              alightingStop: usingCustom ? customStop.trim() : selectedStop,
              alightingStopOrder: stopOrder,
              isCustomAlighting: usingCustom,
              fare,
              paymentStatus: 'pending_sync',
              paymentMethod,
              boardedAt: new Date().toISOString(),
              queuedOffline: true,
            },
          })
        }

        setTimeout(() => {
          setConfirmed(false)
          setQueuedLocally(false)
          setStep(1)
          setSelectedSeat(null)
          setSelectedStop('')
          setCustomStop('')
          setPaymentMethod('')
          setMpesaPhone('')
        }, 3500)
        return
      }

      // --- Online path ---
      const res = await fetch('/api/passengers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, clientId }),
      })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Failed to board')
        setProcessing(false)
        return
      }

      // Emit WS event
      if (busData?.id) {
        emitSocket('passenger_boarded', {
          busId: busData.id,
          passenger: {
            id: data.passenger?.id || 'new',
            name: null,
            phone: paymentMethod === 'mpesa' ? mpesaPhone : null,
            seatNumber: selectedSeat,
            boardingStop: stops[currentStopIndex]?.name || 'Unknown',
            alightingStop: usingCustom ? customStop.trim() : selectedStop,
            alightingStopOrder: stopOrder,
            isCustomAlighting: usingCustom,
            fare,
            paymentStatus: 'paid',
            paymentMethod,
            boardedAt: new Date().toISOString(),
          },
        })
      }

      setProcessing(false)
      setConfirmed(true)
      toast.success('Payment confirmed! 🎉', { description: `Seat ${selectedSeat} booked` })
      onRefresh()

      setTimeout(() => {
        setConfirmed(false)
        setStep(1)
        setSelectedSeat(null)
        setSelectedStop('')
        setCustomStop('')
        setPaymentMethod('')
        setMpesaPhone('')
      }, 3000)
    } catch {
      toast.error('Payment failed')
      setProcessing(false)
    }
  }

  if (confirmed) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 animate-in fade-in zoom-in-90 duration-300"
      >
        <div
          className={`w-20 h-20 rounded-full flex items-center justify-center mb-6 animate-pop ${
            queuedLocally ? 'bg-yellow-100' : 'bg-blue-100'
          }`}
        >
          {queuedLocally ? (
            <CloudOff className="w-10 h-10 text-yellow-600" />
          ) : (
            <CheckCircle2 className="w-10 h-10 text-blue-600" />
          )}
        </div>
        <h2 className={`text-2xl font-bold mb-2 ${queuedLocally ? 'text-yellow-700' : 'text-blue-800'}`}>
          {queuedLocally ? 'Queued offline ⏸' : "You're all set! 🎉"}
        </h2>
        <p className="text-gray-600">Seat {selectedSeat} • {customStop || selectedStop}</p>
        <p className={`${queuedLocally ? 'text-yellow-700' : 'text-blue-600'} font-semibold mt-1`}>KES {fare}</p>
        {queuedLocally && (
          <p className="text-xs text-gray-500 mt-3 max-w-xs text-center">
            Your booking is saved on this device. It will sync to the conductor automatically when you reconnect.
          </p>
        )}
      </div>
    )
  }

  // Compute ETA to passenger's selected alighting stop
  // Prefer real ETA from /api/gps intelligence; fall back to heuristic
  const etaMinutes = (() => {
    if (!selectedStopData) return null
    // Real ETA from server (Haversine + actual speed)
    if (gpsData?.etas) {
      const match = gpsData.etas.find(e => e.order === selectedStopData.order)
      if (match && match.etaMinutes !== null) return match.etaMinutes
    }
    // Fallback: heuristic
    if (!gpsData?.speed || gpsData.speed < 5) return null
    const stopsToGo = selectedStopData.order - (currentStopIndex + 1)
    if (stopsToGo <= 0) return 0
    return Math.max(1, Math.round(stopsToGo * 3 - (stopsToGo * 3 * 0.2)))
  })()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-bold text-blue-800">Welcome aboard! 🚌</h2>
        <p className="text-gray-500 mt-1">Select your seat and destination</p>
      </div>

      {/* Offline / Connectivity banner (Phase 3) */}
      {!isOnline && (
        <div
          className="bg-yellow-50 border-2 border-yellow-400 rounded-lg p-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="w-8 h-8 rounded-full bg-yellow-100 flex items-center justify-center shrink-0">
            <WifiOff className="w-4 h-4 text-yellow-700" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-yellow-800">
              You&apos;re offline — but you can still board
            </p>
            <p className="text-xs text-yellow-700">
              Your booking will be saved on this device and synced to the conductor when you reconnect.
            </p>
          </div>
          {queueCount > 0 && (
            <Badge className="bg-yellow-500 text-yellow-950 hover:bg-yellow-500 shrink-0">
              <Hourglass className="w-3 h-3 mr-1" />
              {queueCount} queued
            </Badge>
          )}
        </div>
      )}
      {isOnline && queueCount > 0 && (
        <div
          className="bg-blue-50 border-2 border-blue-300 rounded-lg p-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
            {isReplaying ? (
              <RefreshCw className="w-4 h-4 text-blue-700 animate-spin" />
            ) : (
              <Wifi className="w-4 h-4 text-blue-700" />
            )}
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-blue-800">
              {isReplaying ? 'Syncing your queued booking…' : `${queueCount} booking${queueCount > 1 ? 's' : ''} queued`}
            </p>
            <p className="text-xs text-blue-600">
              {isReplaying ? 'Almost done — confirming with the conductor.' : 'Click below to retry now, or it will sync automatically.'}
            </p>
          </div>
          {!isReplaying && (
            <Button size="sm" variant="outline" className="border-blue-400 text-blue-700 hover:bg-blue-100" onClick={replay}>
              <RefreshCw className="w-3 h-3 mr-1" /> Sync now
            </Button>
          )}
        </div>
      )}
      {isOnline && staleGps && (
        <div
          className="bg-orange-50 border border-orange-300 rounded-lg p-2.5 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
            <CloudOff className="w-3.5 h-3.5 text-orange-700" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold text-orange-800">
              Live bus data paused — showing last known position
            </p>
            <p className="text-[11px] text-orange-700">
              The bus tablet may be in a tunnel or dead-zone. Your seat + fare are still valid.
            </p>
          </div>
        </div>
      )}

      {/* Off-route alert banner */}
      {gpsData?.isOffRoute && (
        <div
          className="bg-red-50 border-2 border-red-300 rounded-lg p-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <Navigation className="w-4 h-4 text-red-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-700">
              Bus is currently off-route
            </p>
            <p className="text-xs text-red-500">
              {gpsData.offRouteDistance || 0}m from scheduled route — your trip may take longer than expected
            </p>
          </div>
        </div>
      )}

      {/* Mini Live Bus Tracker */}
      <Card className="border-blue-200 bg-gradient-to-br from-blue-50 to-teal-50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2 text-blue-800">
              <Navigation className="w-4 h-4 text-blue-600" />
              Live Bus Tracker
            </CardTitle>
            <button
              onClick={() => setShowMiniMap(s => !s)}
              className="text-xs text-blue-600 hover:text-blue-800 underline"
            >
              {showMiniMap ? 'Hide map' : 'Show map'}
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* GPS status row */}
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <span className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-white border border-blue-200">
              <span className={`w-2 h-2 rounded-full ${gpsData?.speed ? 'bg-blue-500 animate-pulse' : 'bg-gray-300'}`} />
              {gpsData?.speed ? 'Live' : 'Waiting'}
            </span>
            {gpsData?.speed !== undefined && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-blue-200">
                <span className="text-blue-600 font-bold">{gpsData.speed}</span>
                <span className="text-gray-500">km/h</span>
              </span>
            )}
            {gpsData?.routeProgressPercent !== undefined && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-blue-100 border border-blue-300 text-blue-700 font-medium">
                {gpsData.routeProgressPercent}% route
              </span>
            )}
            {gpsData?.atStopName && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-blue-100 border border-blue-300 text-blue-700 font-medium">
                📍 At {gpsData.atStopName}
              </span>
            )}
            {gpsData?.currentLocation && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-blue-200 text-gray-500">
                {gpsData.currentLocation.lat.toFixed(4)}, {gpsData.currentLocation.lng.toFixed(4)}
              </span>
            )}
            {etaMinutes !== null && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 border border-amber-300 text-amber-700 font-medium">
                ETA: ~{etaMinutes} min to {selectedStopData?.name?.split(' ')[0] || 'stop'}
              </span>
            )}
          </div>

          {/* Mini map */}
          {showMiniMap && typeof window !== 'undefined' && miniLeafletReady && (
            <div style={{ height: '180px', borderRadius: '8px', overflow: 'hidden', border: '1px solid #d1d5db' }}>
              <MapContainer
                center={gpsData?.currentLocation ? [gpsData.currentLocation.lat, gpsData.currentLocation.lng] : [-4.05, 39.67]}
                zoom={13}
                style={{ height: '100%', width: '100%' }}
                scrollWheelZoom={false}
                zoomControl={false}
              >
                <MapRecenter position={gpsData?.currentLocation ? [gpsData.currentLocation.lat, gpsData.currentLocation.lng] : null} />
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <Polyline positions={gpsData?.routeLine?.map(p => [p.lat, p.lng]) || []} color="#059669" weight={3} opacity={0.6} />
                {gpsData?.routeStops?.slice(currentStopIndex, currentStopIndex + 3).map(stop => (
                  <Marker key={stop.order} position={[stop.lat, stop.lng]}>
                    <Popup>{stop.stopName}</Popup>
                  </Marker>
                ))}
                {gpsData?.currentLocation && (
                  <Marker position={[gpsData.currentLocation.lat, gpsData.currentLocation.lng]}>
                    <Popup>🚌 Your bus — {gpsData.speed} km/h</Popup>
                  </Marker>
                )}
              </MapContainer>
            </div>
          )}

          {/* Next stop callout */}
          <div className="flex items-center gap-2 text-xs text-blue-700 bg-white/60 rounded-lg p-2">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            <span>
              {gpsData?.currentLocation ? 'Now approaching ' : 'Currently at '}
              <strong>{stops[currentStopIndex]?.name || 'Unknown'}</strong>
              {stops[currentStopIndex + 1] && (
                <> • Next: <strong>{stops[currentStopIndex + 1].name}</strong></>
              )}
            </span>
          </div>

          {/* Last updated */}
          {gpsData?.lastUpdated && (
            <p className="text-[10px] text-gray-400 text-right">
              Updated {new Date(gpsData.lastUpdated).toLocaleTimeString()}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Route Progress Tracker */}
      <Card className="bg-gradient-to-r from-blue-50 to-teal-50 border-blue-200">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Navigation className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-semibold text-blue-800">Route Progress</span>
          </div>
          <div className="relative flex items-center justify-between gap-1">
            {/* Connecting line */}
            <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-gray-200 -translate-y-1/2" />
            <div
              className="absolute top-1/2 left-0 h-0.5 bg-blue-500 -translate-y-1/2 transition-all duration-500"
              style={{ width: `${stops.length > 1 ? (currentStopIndex / (stops.length - 1)) * 100 : 0}%` }}
            />
            {/* Stop dots */}
            {stops.map((stop, i) => (
              <div key={stop.id} className="relative flex flex-col items-center z-10">
                <div
                  className={`w-4 h-4 rounded-full border-2 transition-all duration-300 ${
                    i < currentStopIndex
                      ? 'bg-blue-500 border-blue-500'
                      : i === currentStopIndex
                      ? 'bg-blue-500 border-blue-600 ring-2 ring-yellow-300 scale-125'
                      : 'bg-white border-gray-300'
                  }`}
                >
                  {i === currentStopIndex && (
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-xs">🚌</span>
                  )}
                </div>
                <span
                  className={`text-[9px] mt-1 max-w-[40px] text-center leading-tight truncate ${
                    i === currentStopIndex ? 'font-bold text-blue-700' : 'text-gray-400'
                  }`}
                >
                  {stop.name.split(' ')[0]}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-2 mt-3">
            <span className="text-xs text-gray-500">Current:</span>
            <Badge variant="default" className="bg-blue-600 text-xs">
              {stops[currentStopIndex]?.name || 'Unknown'}
            </Badge>
            {gpsData && gpsData.speed > 0 && (
              <span className="text-xs text-blue-600 font-medium">
                • {gpsData.speed} km/h
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Step indicators */}
      <div className="flex items-center justify-center gap-2">
        {[1, 2, 3].map(s => (
          <React.Fragment key={s}>
            <button
              onClick={() => s < step && setStep(s)}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                step === s ? 'bg-blue-600 text-white scale-110' :
                s < step ? 'bg-blue-200 text-blue-700' :
                'bg-gray-100 text-gray-400'
              }`}
            >
              {s < step ? <CheckCircle2 className="w-4 h-4" /> : s}
            </button>
            {s < 3 && <div className={`w-12 h-0.5 ${s < step ? 'bg-blue-400' : 'bg-gray-200'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 1: Seat Map */}
      {step === 1 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Armchair className="w-5 h-5 text-blue-600" />
              Pick Your Seat
            </CardTitle>
            <CardDescription>
              <span className="flex items-center gap-3 text-xs mt-1">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-100 border border-blue-400" /> Available</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 border border-red-400" /> Occupied</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-400 border border-blue-600" /> Selected</span>
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-w-xs mx-auto grid grid-cols-4 gap-2">
              {/* Row labels: 2 seats | aisle | 2 seats pattern for 14-seat matatu */}
              {Array.from({ length: 14 }, (_, i) => {
                const seatNum = i + 1
                const seat = seats.find(s => s.number === seatNum)
                const isSelected = selectedSeat === seatNum
                const isOccupied = seat?.isOccupied

                // Layout: seats 1-2 per row, aisle break every 2 seats
                const row = Math.floor(i / 2)
                const isRightSide = i % 2 === 1

                return (
                  <React.Fragment key={seatNum}>
                    <button
                      disabled={isOccupied}
                      onClick={() => handleSeatClick(seatNum)}
                      className={`p-2 rounded-lg border-2 text-center transition-all text-sm font-medium ${
                        isSelected ? SEAT_COLORS.selected :
                        isOccupied ? getSeatColor(seat!, currentStopIndex) + ' cursor-not-allowed opacity-70' :
                        SEAT_COLORS.available
                      }`}
                    >
                      <Armchair className="w-4 h-4 mx-auto mb-0.5" />
                      <span className="text-xs">{seatNum}</span>
                    </button>
                    {isRightSide && row < 6 && (
                      <div className="col-span-4 h-1" />
                    )}
                  </React.Fragment>
                )
              })}
            </div>
            {selectedSeat && (
              <div
                className="mt-4 text-center animate-in fade-in slide-in-from-bottom-2 duration-200"
              >
                <Button
                  onClick={() => setStep(2)}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  Continue with Seat {selectedSeat} <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2: Select Alighting Stop */}
      {step === 2 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <MapPin className="w-5 h-5 text-blue-700" />
              Select Your Stop
            </CardTitle>
            <CardDescription>
              Where are you getting off? Fares are auto-calculated from the SACCO&apos;s fare matrix.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
              {stops.filter(s => s.order > currentStopIndex).map(stop => {
                const segmentFare = computeFare(stops, currentStopIndex, stop.name, false)
                return (
                  <button
                    key={stop.id}
                    onClick={() => { setSelectedStop(stop.name); setCustomStop('') }}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                      selectedStop === stop.name
                        ? 'border-blue-600 bg-blue-50'
                        : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50/30'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xs shrink-0">
                      {stop.order}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{stop.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-xs">
                          {stop.isStage ? 'Stage' : 'Custom'}
                        </Badge>
                        {typeof stop.fareFromOrigin === 'number' && (
                          <span className="text-[10px] text-gray-400">
                            fare from origin: KES {stop.fareFromOrigin}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-blue-700 shrink-0">
                      KES {segmentFare}
                    </span>
                    {selectedStop === stop.name && (
                      <CheckCircle2 className="w-5 h-5 text-blue-700 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>

            <Separator />

            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3">
              <p className="text-sm font-medium text-yellow-900 mb-2 flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-yellow-700" />
                Or enter a custom drop-off landmark
              </p>
              <p className="text-[11px] text-yellow-800 mb-2 leading-relaxed">
                For places the driver knows but that aren&apos;t on the registered route —
                e.g. <em>&quot;near Naivas Supermarket&quot;</em> or <em>&quot;after the blue mosque&quot;</em>.
                The driver and conductor will see this flagged on their seat map.
              </p>
              <Input
                placeholder="e.g., Near Naivas Supermarket"
                value={customStop}
                onChange={e => { setCustomStop(e.target.value); setSelectedStop('') }}
                className="text-sm border-yellow-400 focus-visible:ring-yellow-500"
              />
              {usingCustom && (
                <p className="text-xs text-yellow-800 mt-2">
                  Custom drop-off fare: <strong>KES {fare}</strong> (charged to the end of the route — conductor can adjust).
                </p>
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button
                onClick={() => setStep(3)}
                disabled={!selectedStop && !customStop}
                className="bg-blue-700 hover:bg-blue-800 flex-1"
              >
                Continue <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Payment */}
      {step === 3 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-blue-600" />
              Payment
            </CardTitle>
            <CardDescription>Choose your payment method</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-blue-50 rounded-lg p-4 text-center">
              <p className="text-sm text-blue-600">Total Fare</p>
              <p className="text-3xl font-bold text-blue-800">KES {fare}</p>
              <p className="text-xs text-blue-500 mt-1">
                Seat {selectedSeat} → {customStop || selectedStop}
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                { key: 'mpesa', label: 'M-Pesa', icon: <Phone className="w-5 h-5" />, color: 'text-green-600' },
                { key: 'nfc', label: 'NFC', icon: <Nfc className="w-5 h-5" />, color: 'text-orange-500' },
                { key: 'qr', label: 'QR Code', icon: <QrCode className="w-5 h-5" />, color: 'text-purple-600' },
                { key: 'cash', label: 'Cash', icon: <Banknote className="w-5 h-5" />, color: 'text-yellow-600' },
                { key: 'card', label: 'Card', icon: <CreditCard className="w-5 h-5" />, color: 'text-cyan-600' },
              ].map(method => (
                <button
                  key={method.key}
                  onClick={() => setPaymentMethod(method.key)}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border-2 transition-all ${
                    paymentMethod === method.key
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-blue-300'
                  }`}
                >
                  <span className={method.color}>{method.icon}</span>
                  <span className="text-xs font-medium">{method.label}</span>
                </button>
              ))}
            </div>

            {paymentMethod === 'mpesa' && (
              <div
                className="space-y-2 animate-in fade-in duration-200"
              >
                <label className="text-sm font-medium text-gray-700">M-Pesa Phone Number</label>
                <Input
                  placeholder="+254 7XX XXX XXX"
                  value={mpesaPhone}
                  onChange={e => setMpesaPhone(e.target.value)}
                  className="text-sm"
                />
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
              <Button
                onClick={handlePay}
                disabled={!paymentMethod || processing || (paymentMethod === 'mpesa' && !mpesaPhone)}
                className="bg-blue-600 hover:bg-blue-700 flex-1"
              >
                {processing ? (
                  <span className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4 animate-spin" />
                    Processing...
                  </span>
                ) : (
                  <span>Pay KES {fare}</span>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary card */}
      {selectedSeat && (
        <Card className="bg-gradient-to-r from-blue-50 to-teal-50 border-blue-200">
          <CardContent className="p-4">
            <h4 className="font-semibold text-blue-800 text-sm mb-2">Your Trip Summary</h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2">
                <Armchair className="w-4 h-4 text-blue-600" />
                <span className="text-gray-600">Seat:</span>
                <span className="font-medium">{selectedSeat}</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-blue-600" />
                <span className="text-gray-600">To:</span>
                <span className="font-medium truncate">{customStop || selectedStop || '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-blue-600" />
                <span className="text-gray-600">Fare:</span>
                <span className="font-medium">KES {fare}</span>
              </div>
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-blue-600" />
                <span className="text-gray-600">Payment:</span>
                <span className="font-medium capitalize">{paymentMethod || '—'}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
