'use client'

/**
 * /passenger — the full public boarding experience.
 *
 * Public (no auth). The visitor lands here either:
 *   - From the landing page's "Board this matatu" button (?bus=<id>)
 *   - Directly via QR-code scan at a stage (?bus=<id>)
 *   - Manually, in which case we show the SACCO picker first
 *
 * Once a bus is chosen, this page:
 *   1. Fetches bus + trip + seats + transactions via /api/public/bus
 *   2. Connects a WebSocket to receive live seat/GPS updates
 *   3. Renders the existing PassengerPanel — unchanged
 *
 * The PassengerPanel already handles offline boarding via IndexedDB
 * + service-worker Background Sync, so this page is just the host.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import {
  Bus, ArrowLeft, MapPin, Navigation, Users, Wifi, WifiOff,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

import { PassengerPanel } from '@/components/passenger-panel'
import type {
  BusData, GPSData, Stop, Seat, TripData, WSNotification,
} from '@/lib/types'

interface PublicSacco {
  id: string
  name: string
  region: string
  code: string | null
  totalBuses: number
  liveBuses: number
}

interface PublicBusLite {
  id: string
  name: string
  registrationNumber: string
  layoutType: string
  route: { id: string; name: string; code: string | null } | null
  totalSeats: number
  occupiedSeats: number
  availableSeats: number
  isTracking: boolean
  isOffRoute: boolean
  lastSpeed: number
  lastGpsAt: string | null
  activeTrip: { id: string; currentStopIndex: number } | null
}

export default function PassengerPage() {
  const searchParams = useSearchParams()
  const busIdFromQuery = searchParams.get('bus')

  const [busData, setBusData] = useState<BusData | null>(null)
  const [tripData, setTripData] = useState<TripData | null>(null)
  const [transactions, setTransactions] = useState<any[]>([])
  const [gpsData, setGpsData] = useState<GPSData | null>(null)
  const [notifications, setNotifications] = useState<WSNotification[]>([])
  const [loading, setLoading] = useState(true)

  const [saccos, setSaccos] = useState<PublicSacco[]>([])
  const [buses, setBuses] = useState<PublicBusLite[]>([])
  const [selectedSaccoId, setSelectedSaccoId] = useState<string | null>(null)
  const [selectedBusId, setSelectedBusId] = useState<string | null>(busIdFromQuery)

  const socketRef = useRef<Socket | null>(null)
  const busDataRef = useRef<BusData | null>(null)
  useEffect(() => { busDataRef.current = busData }, [busData])

  // ─── Load SACCOs for the picker (only if no ?bus= in URL) ─────
  useEffect(() => {
    if (busIdFromQuery) return  // Skip — already have a target bus
    fetch('/api/public/saccos')
      .then(r => r.json())
      .then(data => {
        setSaccos(data.saccos ?? [])
        const firstLive = (data.saccos ?? []).find((s: PublicSacco) => s.liveBuses > 0)
        if (firstLive) setSelectedSaccoId(firstLive.id)
      })
      .catch(e => console.error('Failed to load SACCOs', e))
  }, [busIdFromQuery])

  // ─── Load buses when a SACCO is picked ────────────────────────
  useEffect(() => {
    if (!selectedSaccoId) {
      setBuses([])
      return
    }
    fetch(`/api/public/buses?saccoId=${encodeURIComponent(selectedSaccoId)}`)
      .then(r => r.json())
      .then(data => setBuses(data.buses ?? []))
      .catch(e => console.error('Failed to load buses', e))
  }, [selectedSaccoId])

  // ─── Fetch bus + trip + seats ─────────────────────────────────
  const refreshBusData = useCallback(async () => {
    if (!selectedBusId) return
    try {
      const res = await fetch(`/api/public/bus?busId=${encodeURIComponent(selectedBusId)}`)
      const data = await res.json()
      if (data.bus) setBusData(data.bus)
      if (data.trip) setTripData(data.trip)
      if (data.transactions) setTransactions(data.transactions)
    } catch (e) {
      console.error('Failed to fetch bus data', e)
    }
  }, [selectedBusId])

  const refreshGpsData = useCallback(async () => {
    const busId = busDataRef.current?.id ?? selectedBusId
    if (!busId) return
    try {
      const params = new URLSearchParams({ busId, history: 'true', limit: '20' })
      const res = await fetch(`/api/gps?${params}`)
      const data = await res.json()
      setGpsData(data)
    } catch (e) {
      console.error('Failed to fetch GPS data', e)
    }
  }, [selectedBusId])

  // ─── Initial load ─────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      if (selectedBusId) {
        await refreshBusData()
        await refreshGpsData()
      }
      setLoading(false)
    }
    load()
  }, [selectedBusId, refreshBusData, refreshGpsData])

  // ─── WebSocket ────────────────────────────────────────────────
  useEffect(() => {
    const socket = io('/?XTransformPort=3003', { transports: ['websocket', 'polling'] })
    socketRef.current = socket

    socket.on('connect', () => { console.log('[WS] Connected') })

    socket.on('passenger_boarded', () => { refreshBusData() })
    socket.on('passenger_alighted', () => { refreshBusData() })
    socket.on('payment_update', () => { refreshBusData() })
    socket.on('advance_stop', () => { refreshBusData() })

    socket.on('gps_update', (data: { busId: string; lat: number; lng: number; speed: number; heading: number; timestamp: string }) => {
      setGpsData(prev => prev ? {
        ...prev,
        currentLocation: { lat: data.lat, lng: data.lng, speed: data.speed, heading: data.heading, timestamp: data.timestamp },
        speed: data.speed,
        heading: data.heading,
        lastUpdated: data.timestamp,
        gpsHistory: [...prev.gpsHistory, { lat: data.lat, lng: data.lng, speed: data.speed, heading: data.heading, timestamp: data.timestamp }].slice(-20),
      } : prev)
    })

    socket.on('notification', (notif: WSNotification) => {
      setNotifications(prev => [notif, ...prev].slice(0, 50))
      if (notif.type === 'crew_broadcast') {
        toast.info(`📢 ${notif.message}`)
      }
    })

    return () => { socket.disconnect() }
  }, [refreshBusData])

  // Re-join bus room when busData loads
  useEffect(() => {
    if (busData?.id && socketRef.current?.connected) {
      socketRef.current.emit('join_bus', busData.id)
    }
  }, [busData?.id])

  const emitSocket = useCallback((event: string, data: any) => {
    socketRef.current?.emit(event, data)
  }, [])

  // ─── Loading ──────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-blue-50/50">
        <div className="text-center animate-in fade-in zoom-in-95 duration-200">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-700 flex items-center justify-center animate-pulse">
            <Bus className="w-8 h-8 text-yellow-300" />
          </div>
          <h2 className="text-xl font-bold text-blue-900">MatatuLink</h2>
          <p className="text-blue-600 text-sm mt-1">Loading your matatu…</p>
        </div>
      </div>
    )
  }

  // ─── No bus selected → show SACCO + bus picker ────────────────
  if (!selectedBusId) {
    return (
      <PassengerPicker
        saccos={saccos}
        buses={buses}
        selectedSaccoId={selectedSaccoId}
        onSelectSacco={setSelectedSaccoId}
        onSelectBus={(id) => setSelectedBusId(id)}
      />
    )
  }

  const stops: Stop[] = busData?.route?.stops || []
  const seats: Seat[] = busData?.seats || []
  const currentStopIndex = tripData?.currentStopIndex || 0

  // ─── Main passenger view ──────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50/80 to-white">
      <header className="sticky top-0 z-50 bg-blue-800 text-white shadow-lg">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
            <div className="w-9 h-9 rounded-full bg-yellow-400 flex items-center justify-center shadow-md">
              <Bus className="w-5 h-5 text-blue-900" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight leading-none">MatatuLink</h1>
              <p className="text-[10px] text-blue-200 leading-none mt-0.5">Passenger</p>
            </div>
          </Link>

          {busData && (
            <div className="text-right">
              <p className="text-sm font-semibold">{busData.registrationNumber}</p>
              <p className="text-[10px] text-blue-200">
                {busData.route?.name ?? 'No route'}
              </p>
            </div>
          )}

          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs text-blue-100 hover:text-white px-2 py-1 rounded border border-blue-400 hover:bg-blue-700/50 transition-colors"
          >
            <ArrowLeft className="w-3 h-3" />
            Change bus
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <div className="animate-in fade-in slide-in-from-bottom-3 duration-200">
          <PassengerPanel
            busData={busData}
            tripData={tripData}
            stops={stops}
            seats={seats}
            currentStopIndex={currentStopIndex}
            gpsData={gpsData}
            emitSocket={emitSocket}
            onRefresh={refreshBusData}
          />
        </div>
      </main>

      <footer className="mt-auto border-t bg-white py-3">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between text-xs text-gray-500">
          <span>© 2026 MatatuLink</span>
          <div className="flex items-center gap-3">
            <Link href="/crew" className="hover:text-blue-700">Crew</Link>
            <Link href="/admin" className="hover:text-blue-700">Admin</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

// ─── SACCO + Bus picker (shown when no ?bus= in URL) ─────────────
function PassengerPicker({
  saccos, buses, selectedSaccoId, onSelectSacco, onSelectBus,
}: {
  saccos: PublicSacco[]
  buses: PublicBusLite[]
  selectedSaccoId: string | null
  onSelectSacco: (id: string) => void
  onSelectBus: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = saccos.filter(s => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.region.toLowerCase().includes(q) ||
      (s.code ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50 to-white">
      <header className="sticky top-0 z-50 bg-blue-800 text-white shadow-lg">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 hover:opacity-90">
            <div className="w-9 h-9 rounded-full bg-yellow-400 flex items-center justify-center">
              <Bus className="w-5 h-5 text-blue-900" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-none">MatatuLink</h1>
              <p className="text-[10px] text-blue-200 mt-0.5">Pick your matatu</p>
            </div>
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs text-blue-100 hover:text-white px-2 py-1 rounded border border-blue-400"
          >
            <ArrowLeft className="w-3 h-3" />
            Home
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-8">
        <h2 className="text-2xl font-bold text-blue-900 mb-1">Pick a SACCO</h2>
        <p className="text-gray-600 text-sm mb-6">
          Then choose which bus to board. You won&apos;t need an account —
          just a seat.
        </p>

        <div className="relative mb-6">
          <Input
            type="text"
            placeholder="Search SACCO, region, or route code…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-10"
          />
          <Bus className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        </div>

        {saccos.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Bus className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Loading SACCOs…</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3 mb-8">
            {filtered.map(sacco => (
              <button
                key={sacco.id}
                onClick={() => onSelectSacco(sacco.id)}
                className={`text-left p-4 rounded-lg border transition-all ${
                  sacco.id === selectedSaccoId
                    ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-600'
                    : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-blue-900 flex items-center gap-2">
                    <Bus className="w-4 h-4 text-blue-600" />
                    {sacco.name}
                  </h3>
                  {sacco.liveBuses > 0 && (
                    <span className="flex items-center gap-1 text-[10px] font-semibold text-green-600">
                      <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                      LIVE
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {sacco.region}
                  {sacco.code && <Badge variant="secondary" className="ml-1 text-[10px] py-0">#{sacco.code}</Badge>}
                </p>
                <p className="text-[11px] text-gray-400 mt-1">
                  {sacco.totalBuses} bus{sacco.totalBuses !== 1 ? 'es' : ''} · {sacco.liveBuses} live
                </p>
              </button>
            ))}
          </div>
        )}

        {selectedSaccoId && (
          <div>
            <h3 className="text-lg font-semibold text-blue-900 mb-3">
              Choose your bus
            </h3>
            {buses.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-gray-500 text-sm">
                  No buses registered for this SACCO yet.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {buses.map(bus => (
                  <Card
                    key={bus.id}
                    className="cursor-pointer hover:shadow-md hover:border-blue-300 transition-all"
                    onClick={() => onSelectBus(bus.id)}
                  >
                    <CardContent className="p-4 flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-blue-900">{bus.registrationNumber}</span>
                          {bus.route?.code && (
                            <Badge variant="secondary" className="text-[10px] py-0">#{bus.route.code}</Badge>
                          )}
                          {bus.isTracking ? (
                            <span className="flex items-center gap-1 text-[10px] font-semibold text-green-600">
                              <Wifi className="w-2.5 h-2.5" />
                              LIVE
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[10px] font-semibold text-gray-400">
                              <WifiOff className="w-2.5 h-2.5" />
                              PARKED
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-1">{bus.route?.name ?? 'No route'}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right text-xs">
                          <div className="flex items-center gap-1 text-gray-700">
                            <Users className="w-3 h-3" />
                            <span className={bus.availableSeats === 0 ? 'text-red-600 font-semibold' : ''}>
                              {bus.availableSeats}/{bus.totalSeats} free
                            </span>
                          </div>
                          {bus.activeTrip && (
                            <p className="text-[10px] text-blue-600 flex items-center gap-0.5 justify-end mt-0.5">
                              <Navigation className="w-2.5 h-2.5" />
                              Stop #{bus.activeTrip.currentStopIndex + 1}
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          disabled={bus.availableSeats === 0}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelectBus(bus.id)
                          }}
                        >
                          {bus.availableSeats === 0 ? 'Full' : 'Board'}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
