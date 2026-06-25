'use client'

/**
 * MatatuLink landing page — IS the passenger interface.
 *
 * Public (no auth). One page, three progressive views:
 *
 *   1. SACCO picker (default) — "Find your matatu"
 *      Lists every SACCO with live bus counts. Search by name/region/code.
 *
 *   2. Bus picker (after SACCO selected) — "Choose your bus"
 *      Lists buses in the selected SACCO with seat availability, live
 *      GPS dot, current stop, and "Board" button.
 *
 *   3. Boarding flow (after bus selected) — PassengerPanel
 *      The full seat → M-Pesa → confirmation flow. Offline-capable via
 *      IndexedDB + SW Background Sync. Accepts ?bus=<id> deep-link
 *      (from QR code scan) to skip straight here.
 *
 * Deep-link: /?bus=<id> skips the pickers and goes straight to boarding.
 * This is the URL printed on QR codes at stages and on bus doors.
 */
import React, { useEffect, useState, useRef, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import {
  Bus, ArrowLeft, MapPin, Navigation, Users, Wifi, WifiOff,
  Search, ShieldCheck, CreditCard, CloudOff, Clock,
  UserCheck, BarChart3, ArrowRight,
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
  sacco: { id: string; name: string; region: string; code: string | null }
  route: {
    id: string
    name: string
    code: string | null
    stops: Array<{ id: string; name: string; order: number; fareFromOrigin: number | null }>
  } | null
  totalSeats: number
  occupiedSeats: number
  availableSeats: number
  isTracking: boolean
  isOffRoute: boolean
  lastSpeed: number
  lastGpsAt: string | null
  activeTrip: { id: string; status: string; currentStopIndex: number; startTime: string } | null
}

export default function PassengerLandingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-blue-50/50">
        <div className="text-center animate-in fade-in zoom-in-95 duration-200">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-700 flex items-center justify-center animate-pulse">
            <Bus className="w-8 h-8 text-yellow-300" />
          </div>
          <h2 className="text-xl font-bold text-blue-900">MatatuLink</h2>
          <p className="text-blue-600 text-sm mt-1">Loading…</p>
        </div>
      </div>
    }>
      <PassengerLanding />
    </Suspense>
  )
}

function PassengerLanding() {
  const searchParams = useSearchParams()
  const busIdFromQuery = searchParams.get('bus')

  // ─── Progressive view state ───────────────────────────────────
  // view = 'picker' (SACCO + bus selection) | 'boarding' (PassengerPanel)
  const [view, setView] = useState<'picker' | 'boarding'>('picker')

  // Picker state
  const [saccos, setSaccos] = useState<PublicSacco[]>([])
  const [buses, setBuses] = useState<PublicBusLite[]>([])
  const [selectedSaccoId, setSelectedSaccoId] = useState<string | null>(null)
  const [selectedBus, setSelectedBus] = useState<PublicBusLite | null>(null)
  const [query, setQuery] = useState('')
  const [loadingBuses, setLoadingBuses] = useState(false)

  // Boarding state (for PassengerPanel)
  const [busData, setBusData] = useState<BusData | null>(null)
  const [tripData, setTripData] = useState<TripData | null>(null)
  const [gpsData, setGpsData] = useState<GPSData | null>(null)
  const [loadingBoarding, setLoadingBoarding] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const busDataRef = useRef<BusData | null>(null)
  useEffect(() => { busDataRef.current = busData }, [busData])

  // ─── Load SACCOs on mount ─────────────────────────────────────
  useEffect(() => {
    fetch('/api/public/saccos')
      .then(r => r.json())
      .then(data => {
        setSaccos(data.saccos ?? [])
        const firstLive = (data.saccos ?? []).find((s: PublicSacco) => s.liveBuses > 0)
        if (firstLive) setSelectedSaccoId(firstLive.id)
      })
      .catch(e => console.error('Failed to load SACCOs', e))
  }, [])

  // ─── If ?bus= in URL, skip picker and go straight to boarding ─
  useEffect(() => {
    if (!busIdFromQuery) return
    enterBoarding(busIdFromQuery)
  }, [busIdFromQuery])

  // ─── Load buses when a SACCO is selected ──────────────────────
  useEffect(() => {
    if (!selectedSaccoId) {
      setBuses([])
      return
    }
    setLoadingBuses(true)
    fetch(`/api/public/buses?saccoId=${encodeURIComponent(selectedSaccoId)}`)
      .then(r => r.json())
      .then(data => setBuses(data.buses ?? []))
      .catch(e => console.error('Failed to load buses', e))
      .finally(() => setLoadingBuses(false))
  }, [selectedSaccoId])

  // Auto-refresh bus list every 15s while on the picker
  useEffect(() => {
    if (view !== 'picker' || !selectedSaccoId) return
    const id = setInterval(() => {
      fetch(`/api/public/buses?saccoId=${encodeURIComponent(selectedSaccoId)}`)
        .then(r => r.json())
        .then(data => setBuses(data.buses ?? []))
        .catch(() => {})
    }, 15000)
    return () => clearInterval(id)
  }, [view, selectedSaccoId])

  // ─── Enter boarding flow ──────────────────────────────────────
  const enterBoarding = useCallback(async (busId: string) => {
    setView('boarding')
    setLoadingBoarding(true)
    try {
      // Fetch full bus + trip + seats + transactions
      const busRes = await fetch(`/api/public/bus?busId=${encodeURIComponent(busId)}`).then(r => r.json())
      if (busRes.bus) {
        setBusData(busRes.bus)
        setTripData(busRes.trip ?? null)
        // Track the lite bus object for the header
        setSelectedBus({
          id: busRes.bus.id,
          name: busRes.bus.name,
          registrationNumber: busRes.bus.registrationNumber,
          layoutType: busRes.bus.layoutType,
          sacco: busRes.bus.sacco,
          route: busRes.bus.route ? {
            id: busRes.bus.route.id,
            name: busRes.bus.route.name,
            code: busRes.bus.route.code,
            stops: busRes.bus.route.stops.map((s: any) => ({
              id: s.id, name: s.name, order: s.order, fareFromOrigin: s.fareFromOrigin,
            })),
          } : null,
          totalSeats: busRes.bus.seats?.length ?? busRes.bus.totalSeats,
          occupiedSeats: busRes.bus.seats?.filter((s: any) => s.isOccupied).length ?? 0,
          availableSeats: busRes.bus.seats?.filter((s: any) => !s.isOccupied).length ?? 0,
          isTracking: busRes.bus.isTracking,
          isOffRoute: busRes.bus.isOffRoute,
          lastSpeed: busRes.bus.lastSpeed ?? 0,
          lastGpsAt: busRes.bus.lastGpsAt,
          activeTrip: busRes.trip ? {
            id: busRes.trip.id,
            status: busRes.trip.status,
            currentStopIndex: busRes.trip.currentStopIndex,
            startTime: busRes.trip.startTime,
          } : null,
        })
      }
      // Fetch GPS
      try {
        const gpsParams = new URLSearchParams({ busId, history: 'true', limit: '20' })
        const gpsRes = await fetch(`/api/gps?${gpsParams}`).then(r => r.json())
        setGpsData(gpsRes)
      } catch {}
    } catch (e) {
      console.error('Failed to load bus for boarding', e)
      toast.error('Could not load this bus. Try another.')
      setView('picker')
    } finally {
      setLoadingBoarding(false)
    }
  }, [])

  // ─── Refresh bus data (for PassengerPanel onRefresh) ──────────
  const refreshBusData = useCallback(async () => {
    const busId = busDataRef.current?.id
    if (!busId) return
    try {
      const res = await fetch(`/api/public/bus?busId=${encodeURIComponent(busId)}`)
      const data = await res.json()
      if (data.bus) setBusData(data.bus)
      if (data.trip) setTripData(data.trip)
    } catch (e) {
      console.error('Failed to refresh bus data', e)
    }
  }, [])

  // ─── WebSocket (for boarding view) ────────────────────────────
  useEffect(() => {
    if (view !== 'boarding') return
    const socket = io('/?XTransformPort=3003', { transports: ['websocket', 'polling'] })
    socketRef.current = socket

    socket.on('connect', () => { console.log('[WS] Connected') })
    socket.on('passenger_boarded', () => refreshBusData())
    socket.on('passenger_alighted', () => refreshBusData())
    socket.on('payment_update', () => refreshBusData())
    socket.on('advance_stop', () => refreshBusData())

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
      if (notif.type === 'crew_broadcast') {
        toast.info(`📢 ${notif.message}`)
      }
    })

    return () => { socket.disconnect() }
  }, [view, refreshBusData])

  // Join bus room when busData loads
  useEffect(() => {
    if (view === 'boarding' && busData?.id && socketRef.current?.connected) {
      socketRef.current.emit('join_bus', busData.id)
    }
  }, [view, busData?.id])

  const emitSocket = useCallback((event: string, data: any) => {
    socketRef.current?.emit(event, data)
  }, [])

  // ─── Render: BOARDING view ────────────────────────────────────
  if (view === 'boarding') {
    if (loadingBoarding) {
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

    const stops: Stop[] = busData?.route?.stops || []
    const seats: Seat[] = busData?.seats || []
    const currentStopIndex = tripData?.currentStopIndex || 0

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

            {selectedBus && (
              <div className="text-right">
                <p className="text-sm font-semibold">{selectedBus.registrationNumber}</p>
                <p className="text-[10px] text-blue-200">
                  {selectedBus.route?.name ?? 'No route'}
                </p>
              </div>
            )}

            <button
              onClick={() => {
                setView('picker')
                setBusData(null)
                setTripData(null)
                setGpsData(null)
                // Clear ?bus= from URL
                if (busIdFromQuery) {
                  window.history.replaceState({}, '', '/')
                }
              }}
              className="inline-flex items-center gap-1 text-xs text-blue-100 hover:text-white px-2 py-1 rounded border border-blue-400 hover:bg-blue-700/50 transition-colors"
            >
              <ArrowLeft className="w-3 h-3" />
              Change bus
            </button>
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

  // ─── Render: PICKER view (default landing) ────────────────────
  const filteredSaccos = saccos.filter(s => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.region.toLowerCase().includes(q) ||
      (s.code ?? '').toLowerCase().includes(q)
    )
  })

  const selectedSacco = saccos.find(s => s.id === selectedSaccoId)

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50 to-white">
      {/* Top nav */}
      <nav className="sticky top-0 z-40 bg-blue-800 text-white shadow-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-yellow-400 flex items-center justify-center shadow-md">
              <Bus className="w-5 h-5 text-blue-900" />
            </div>
            <div>
              <span className="text-lg font-bold tracking-tight block leading-none">MatatuLink</span>
              <span className="text-[10px] text-blue-200">Board your matatu</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/"
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-yellow-400 text-blue-900 hover:bg-yellow-300 transition-colors"
            >
              Passenger
            </Link>
            <Link
              href="/crew"
              className="px-3 py-1.5 rounded-md text-xs font-medium text-blue-100 hover:bg-blue-700/50 hover:text-white transition-colors"
            >
              Crew
            </Link>
            <Link
              href="/admin"
              className="px-3 py-1.5 rounded-md text-xs font-medium text-blue-100 hover:bg-blue-700/50 hover:text-white transition-colors"
            >
              Admin
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero + feature pills (only shown when no SACCO selected yet) */}
      {!selectedSacco && (
        <section className="bg-gradient-to-br from-blue-900 via-blue-800 to-blue-950 text-white">
          <div className="max-w-6xl mx-auto px-4 py-10 md:py-14 grid md:grid-cols-2 gap-8 items-center">
            <div>
              <Badge className="bg-yellow-400 text-blue-900 hover:bg-yellow-300 mb-4">
                Built for Kenyan SACCOs
              </Badge>
              <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">
                Board your matatu.<br />
                <span className="text-yellow-400">Pay with M-Pesa.</span><br />
                Track every stop.
              </h1>
              <p className="mt-4 text-blue-100 text-base md:text-lg max-w-md">
                No app to install. No account needed. Find your SACCO,
                pick a seat, and ride — even when the network drops.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="#find-matatu"
                  className="inline-flex items-center gap-2 bg-yellow-400 text-blue-900 px-5 py-2.5 rounded-lg font-semibold hover:bg-yellow-300 transition-colors"
                >
                  <Search className="w-4 h-4" />
                  Find your matatu
                </a>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FeatureCard icon={<Wifi className="w-5 h-5" />} title="Works offline" body="Board + pay in dead zones. Syncs when you reconnect." />
              <FeatureCard icon={<CreditCard className="w-5 h-5" />} title="M-Pesa, cash, card" body="Pay how you want. Conductor sees it instantly." />
              <FeatureCard icon={<Navigation className="w-5 h-5" />} title="Live GPS" body="See the bus move. Know your stop is coming up." />
              <FeatureCard icon={<ShieldCheck className="w-5 h-5" />} title="No double-charge" body="Every booking has a unique ID. Safe replay on reconnect." />
            </div>
          </div>
        </section>
      )}

      {/* Picker section */}
      <section id="find-matatu" className="max-w-6xl w-full mx-auto px-4 py-8 md:py-10">
        {selectedSacco && (
          <button
            onClick={() => setSelectedSaccoId(null)}
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-blue-700 mb-4"
          >
            <ArrowLeft className="w-3 h-3" />
            All SACCOs
          </button>
        )}

        <div className="mb-6">
          <h2 className="text-2xl md:text-3xl font-bold text-blue-900">
            {selectedSacco ? `${selectedSacco.name} — choose your bus` : 'Find your matatu'}
          </h2>
          <p className="text-gray-600 text-sm mt-1">
            {selectedSacco
              ? `${selectedSacco.region} · ${buses.length} bus${buses.length !== 1 ? 'es' : ''} total`
              : 'Pick your SACCO to see live buses. Tap a bus to choose your seat.'}
          </p>
        </div>

        {/* SACCO picker (shown when no SACCO selected) */}
        {!selectedSacco && (
          <>
            <div className="relative mb-6 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                type="text"
                placeholder="Search SACCO, region, or route code…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            {saccos.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Bus className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>Loading SACCOs…</p>
              </div>
            ) : filteredSaccos.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>No SACCOs match &ldquo;{query}&rdquo;.</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredSaccos.map(sacco => (
                  <Card
                    key={sacco.id}
                    className="cursor-pointer transition-all hover:shadow-md hover:border-blue-300"
                    onClick={() => setSelectedSaccoId(sacco.id)}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-base text-blue-900 flex items-center gap-2">
                            <Bus className="w-4 h-4 text-blue-600" />
                            {sacco.name}
                          </CardTitle>
                          <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                            <MapPin className="w-3 h-3" />
                            {sacco.region}
                            {sacco.code && (
                              <Badge variant="secondary" className="ml-1 text-[10px] py-0">
                                #{sacco.code}
                              </Badge>
                            )}
                          </p>
                        </div>
                        {sacco.liveBuses > 0 && (
                          <span className="flex items-center gap-1 text-[10px] font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                            LIVE
                          </span>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-500">
                          {sacco.totalBuses} bus{sacco.totalBuses !== 1 ? 'es' : ''}
                        </span>
                        <span className={sacco.liveBuses > 0 ? 'text-green-600 font-medium' : 'text-gray-400'}>
                          {sacco.liveBuses} on the road
                        </span>
                      </div>
                      <Button size="sm" variant="outline" className="w-full mt-3">
                        Show buses
                        <ArrowRight className="w-3.5 h-3.5 ml-1" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        {/* Bus list (shown when a SACCO is selected) */}
        {selectedSacco && (
          <div className="bg-white rounded-xl border border-blue-100 shadow-sm">
            <div className="px-5 py-4 border-b border-blue-50 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-blue-900">{selectedSacco.name}</h3>
                <p className="text-xs text-gray-500">
                  {selectedSacco.region} · {buses.length} bus{buses.length !== 1 ? 'es' : ''} total
                </p>
              </div>
              {loadingBuses && (
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Clock className="w-3 h-3 animate-spin" />
                  Refreshing…
                </span>
              )}
            </div>

            {buses.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">
                No buses registered for this SACCO yet.
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {buses.map(bus => (
                  <BusRow
                    key={bus.id}
                    bus={bus}
                    onBoard={() => enterBoarding(bus.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Three-interfaces section */}
      {!selectedSacco && (
        <section className="bg-blue-50/50 border-t border-blue-100">
          <div className="max-w-6xl mx-auto px-4 py-10">
            <h2 className="text-2xl md:text-3xl font-bold text-blue-900 text-center mb-2">
              One platform, three faces
            </h2>
            <p className="text-gray-600 text-sm text-center mb-8 max-w-2xl mx-auto">
              The passenger side is free and open. Crew and admin are auth-gated
              so only your SACCO staff see your data.
            </p>

            <div className="grid md:grid-cols-3 gap-6">
              <RoleCard
                active
                icon={<Users className="w-6 h-6" />}
                title="Passenger"
                tag="Public — no sign-in"
                body="Find a matatu, pick your seat, pay with M-Pesa, track your stop. Works offline."
                href="/"
                cta="You are here"
              />
              <RoleCard
                icon={<UserCheck className="w-6 h-6" />}
                title="Crew"
                tag="Sign-in required"
                body="Conductors board passengers, accept fares, broadcast messages. Drivers advance stops, track GPS."
                href="/crew"
                cta="Crew sign-in"
              />
              <RoleCard
                icon={<BarChart3 className="w-6 h-6" />}
                title="Admin (SACCO owner)"
                tag="Sign-in required"
                body="Live fleet map, revenue dashboards, route manager, CSV route upload, fleet-wide alerts."
                href="/admin"
                cta="Admin sign-in"
              />
            </div>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="bg-blue-900 text-blue-100 py-6 mt-auto">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between text-xs flex-wrap gap-2">
          <span>© 2026 MatatuLink · Built for Kenyan SACCOs</span>
          <div className="flex items-center gap-3">
            <Link href="/" className="hover:text-white">Passenger</Link>
            <Link href="/crew" className="hover:text-white">Crew</Link>
            <Link href="/admin" className="hover:text-white">Admin</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-white/10 backdrop-blur rounded-lg p-4 border border-white/20">
      <div className="w-8 h-8 rounded-md bg-yellow-400 text-blue-900 flex items-center justify-center mb-2">
        {icon}
      </div>
      <h4 className="font-semibold text-sm">{title}</h4>
      <p className="text-blue-100 text-xs mt-1 leading-snug">{body}</p>
    </div>
  )
}

function RoleCard({
  icon, title, tag, body, href, cta, active,
}: {
  icon: React.ReactNode
  title: string
  tag: string
  body: string
  href: string
  cta: string
  active?: boolean
}) {
  return (
    <Card className={`flex flex-col ${active ? 'ring-2 ring-yellow-400' : ''}`}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
            active ? 'bg-yellow-400 text-blue-900' : 'bg-blue-100 text-blue-700'
          }`}>
            {icon}
          </div>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="text-[11px] text-gray-500">{tag}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col">
        <p className="text-sm text-gray-600 mb-4 flex-1">{body}</p>
        <Link
          href={href}
          className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            active
              ? 'bg-blue-700 text-white hover:bg-blue-800'
              : 'border border-blue-200 text-blue-700 hover:bg-blue-50'
          }`}
        >
          {cta}
          {!active && <ArrowRight className="w-3.5 h-3.5" />}
        </Link>
      </CardContent>
    </Card>
  )
}

function BusRow({ bus, onBoard }: { bus: PublicBusLite; onBoard: () => void }) {
  const available = bus.availableSeats
  const total = bus.totalSeats
  const occupancyPct = total > 0 ? Math.round((bus.occupiedSeats / total) * 100) : 0

  const gpsAge = bus.lastGpsAt ? Math.round((Date.now() - new Date(bus.lastGpsAt).getTime()) / 1000) : null
  const gpsFresh = gpsAge !== null && gpsAge < 60

  const firstStop = bus.route?.stops[0]?.name
  const lastStop = bus.route?.stops[bus.route.stops.length - 1]?.name

  return (
    <div className="p-4 hover:bg-blue-50/40 transition-colors">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-blue-900">{bus.registrationNumber}</span>
            {bus.route?.code && (
              <Badge variant="secondary" className="text-[10px] py-0">#{bus.route.code}</Badge>
            )}
            {bus.isTracking ? (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-green-600">
                <span className={`w-1.5 h-1.5 bg-green-500 rounded-full ${gpsFresh ? 'animate-pulse' : ''}`} />
                LIVE {gpsFresh ? '' : `· ${gpsAge}s ago`}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-gray-400">
                <WifiOff className="w-2.5 h-2.5" />
                PARKED
              </span>
            )}
            {bus.isOffRoute && (
              <Badge variant="destructive" className="text-[10px] py-0">Off route</Badge>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1 truncate">
            {bus.route ? `${firstStop} → ${lastStop}` : 'No route assigned'}
          </p>
          {bus.activeTrip && (
            <p className="text-[11px] text-blue-600 mt-0.5 flex items-center gap-1">
              <Navigation className="w-2.5 h-2.5" />
              Currently at stop #{bus.activeTrip.currentStopIndex + 1}
              {bus.lastSpeed > 0 && ` · ${Math.round(bus.lastSpeed)} km/h`}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 min-w-[120px]">
          <div className="flex items-center gap-1.5 text-xs">
            <Users className="w-3 h-3 text-gray-400" />
            <span className={available === 0 ? 'text-red-600 font-semibold' : 'text-gray-700'}>
              {available}/{total} free
            </span>
          </div>
          <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${
                occupancyPct >= 90 ? 'bg-red-500' : occupancyPct >= 60 ? 'bg-yellow-500' : 'bg-green-500'
              }`}
              style={{ width: `${occupancyPct}%` }}
            />
          </div>
        </div>

        <Button
          size="sm"
          disabled={available === 0}
          onClick={onBoard}
          className={available === 0 ? 'bg-gray-200 text-gray-400' : 'bg-blue-700 hover:bg-blue-800'}
        >
          {available === 0 ? 'Full' : 'Board this matatu'}
          {available > 0 && <ArrowRight className="w-3.5 h-3.5 ml-1" />}
        </Button>
      </div>
    </div>
  )
}
