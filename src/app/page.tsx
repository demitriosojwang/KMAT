'use client'

import dynamic from 'next/dynamic'
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { signIn, signOut, useSession } from 'next-auth/react'
import {
  Bus, Users, UserCheck, Car, BarChart3,
  Armchair, MapPin, CreditCard, CheckCircle2,
  Phone, QrCode, Banknote, Nfc,
  Navigation, ChevronRight, Clock, DollarSign,
  MessageSquare, Send, RotateCcw,
  TrendingUp, PieChart as PieChartIcon, Activity,
  User, ArrowRight, Radio, Bell as BellIcon,
  Plus, Route as RouteIcon, Trash2, Building2,
  LogIn, LogOut, Mail, Lock, Upload, FileSpreadsheet,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────
interface Stop {
  id: string
  name: string
  order: number
  isStage: boolean
  routeId: string
  lat?: number | null
  lng?: number | null
  fareFromOrigin?: number | null
}

interface Passenger {
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

interface Seat {
  id: string
  number: number
  row?: number
  col?: number
  isOccupied: boolean
  passenger: Passenger | null
  busId: string
}

type BusLayoutType = 'matatu_14' | 'coaster_33' | 'van_11'

interface BusData {
  id: string
  name: string
  registrationNumber: string
  totalSeats: number
  layoutType?: BusLayoutType
  route: { id: string; name: string; code?: string | null; stops: Stop[] } | null
  seats: Seat[]
  sacco: { id: string; name: string; region?: string; code?: string | null }
}

interface TripData {
  id: string
  currentStopIndex: number
  status: string
  totalPassengers: number
  totalRevenue: number
  passengers: Passenger[]
  bus: BusData & { route: { stops: Stop[] } | null; seats: Seat[] }
}

interface Transaction {
  id: string
  passengerId: string
  amount: number
  method: string
  status: string
  reference: string | null
  createdAt: string
}

interface WSNotification {
  id: string
  type: string
  message: string
  target: string
  timestamp: string
  read: boolean
}

interface GPSLocation {
  lat: number
  lng: number
  speed: number
  heading: number
  timestamp: string
}

interface GPSData {
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
}

// ─── Color helpers ────────────────────────────────────────────────
// MatatuLink brand palette: BLUE (primary) + YELLOW (accent).
// State indicators (red/orange) are kept semantic — they communicate
// seat status, not brand identity.
const PAYMENT_COLORS: Record<string, string> = {
  mpesa: '#16a34a',
  cash: '#eab308',
  qr: '#8b5cf6',
  nfc: '#f97316',
  card: '#06b6d4',
}

const SEAT_COLORS = {
  available: 'bg-blue-50 border-blue-300 hover:bg-blue-100 cursor-pointer text-blue-700',
  occupied: 'bg-red-100 border-red-400',
  occupiedFar: 'bg-orange-100 border-orange-400',
  unpaid: 'bg-yellow-100 border-yellow-500 border-dashed',
  selected: 'bg-yellow-400 border-yellow-600 text-yellow-950 ring-2 ring-yellow-300',
}

function getSeatColor(seat: Seat, currentStopIndex: number): string {
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
function computeFare(
  stops: Stop[],
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

// ─── Dynamic Leaflet Imports (SSR-safe) ──────────────────────────
const MapContainer = dynamic(
  () => import('react-leaflet').then(mod => mod.MapContainer),
  { ssr: false, loading: () => <div style={{ height: '300px', background: '#f0fdf4', borderRadius: '8px' }} className="flex items-center justify-center text-blue-600 text-sm">Loading map...</div> }
)
const TileLayer = dynamic(
  () => import('react-leaflet').then(mod => mod.TileLayer),
  { ssr: false }
)
const Marker = dynamic(
  () => import('react-leaflet').then(mod => mod.Marker),
  { ssr: false }
)
const Popup = dynamic(
  () => import('react-leaflet').then(mod => mod.Popup),
  { ssr: false }
)
const Polyline = dynamic(
  () => import('react-leaflet').then(mod => mod.Polyline),
  { ssr: false }
)

// Static import for useMap hook (must NOT be dynamic, since it's a hook)
import { useMap as useLeafletMap } from 'react-leaflet'

// Component that recenters the map when bus position changes
function MapRecenter({ position }: { position: [number, number] | null }) {
  const map = useLeafletMap()
  useEffect(() => {
    if (map && position) {
      try { map.panTo(position, { animate: true, duration: 0.8 }) } catch {}
    }
  }, [map, position])
  return null
}

// ─── Main Component ───────────────────────────────────────────────
type TabType = 'passenger' | 'conductor' | 'driver' | 'owner'

export default function Home() {
  // NextAuth session — drives the SACCO context. When unauthenticated
  // the user sees a sign-in card instead of the dashboard.
  const { data: session, status } = useSession()

  const [activeTab, setActiveTab] = useState<TabType>('passenger')
  const [busData, setBusData] = useState<BusData | null>(null)
  const [tripData, setTripData] = useState<TripData | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [notifications, setNotifications] = useState<WSNotification[]>([])
  const [gpsData, setGpsData] = useState<GPSData | null>(null)
  const [fleetData, setFleetData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const socketRef = useRef<Socket | null>(null)
  const busDataRef = useRef<BusData | null>(null)
  const activeTabRef = useRef<TabType>('passenger')
  const fetchFleetDataRef = useRef<(() => Promise<void>) | null>(null)

  // ─── Multi-SACCO state ──────────────────────────────────────────
  // After NextAuth login the ownerId comes from the session JWT. We
  // still keep the ownerId in local state so existing fetch helpers
  // don't need to be rewritten.
  const sessionOwnerId = (session as any)?.ownerId as string | undefined
  const [ownerId, setOwnerId] = useState<string | null>(sessionOwnerId ?? null)
  const [ownerList, setOwnerList] = useState<Array<{ email: string; name: string; saccoName: string; region: string }>>([])
  const [ownerMeta, setOwnerMeta] = useState<{ saccoName: string; region: string } | null>(null)

  // ─── Sign-in form state ─────────────────────────────────────────
  const [signInEmail, setSignInEmail] = useState('')
  const [signInPassword, setSignInPassword] = useState('')
  const [signInLoading, setSignInLoading] = useState(false)

  // ─── Active bus selector (Conductor/Driver/Passenger operate one bus) ─
  const [busList, setBusList] = useState<Array<{ id: string; name: string; registrationNumber: string; totalSeats: number; layoutType?: string; routeName?: string | null; routeCode?: string | null }>>([])
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null)

  // ─── Fleet data fetching (for Owner panel) ────────────────────
  const fetchFleetData = useCallback(async () => {
    try {
      const qs = ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : ''
      const res = await fetch(`/api/fleet${qs}`)
      const data = await res.json()
      setFleetData(data)
    } catch (e) {
      console.error('Failed to fetch fleet data', e)
    }
  }, [ownerId])

  // Keep refs in sync for use inside socket callbacks
  useEffect(() => {
    busDataRef.current = busData
  }, [busData])

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])

  useEffect(() => {
    fetchFleetDataRef.current = fetchFleetData
  }, [fetchFleetData])

  // ─── Data fetching ────────────────────────────────────────────
  const fetchBusData = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (ownerId) params.set('ownerId', ownerId)
      if (selectedBusId) params.set('busId', selectedBusId)
      const qs = params.toString()
      const res = await fetch(`/api/bus${qs ? `?${qs}` : ''}`)
      const data = await res.json()
      if (data.bus) setBusData(data.bus)
      if (data.trip) setTripData(data.trip)
      if (data.transactions) setTransactions(data.transactions)
    } catch (e) {
      console.error('Failed to fetch bus data', e)
    }
  }, [ownerId, selectedBusId])

  const fetchOwnerData = useCallback(async () => {
    // Owner data is fetched within OwnerPanel
  }, [])

  const fetchTripData = useCallback(async () => {
    try {
      const res = await fetch('/api/trip')
      const data = await res.json()
      if (data.trip) setTripData(data.trip)
    } catch (e) {
      console.error('Failed to fetch trip data', e)
    }
  }, [])

  const fetchGpsData = useCallback(async () => {
    try {
      const busId = busDataRef.current?.id
      const params = new URLSearchParams()
      if (busId) {
        params.set('busId', busId)
        params.set('history', 'true')
        params.set('limit', '20')
      }
      const url = `/api/gps${params.toString() ? `?${params}` : ''}`
      const res = await fetch(url)
      const data = await res.json()
      setGpsData(data)
    } catch (e) {
      console.error('Failed to fetch GPS data', e)
    }
  }, [])

  // ─── Socket emit helpers (access ref in callbacks, not during render) ─
  const emitSocket = useCallback((event: string, data: any) => {
    socketRef.current?.emit(event, data)
  }, [])

  // ─── Initial load ─────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      // Fetch /api/me — returns the current session (if any) plus the
      // list of demo owner emails so the sign-in card can show a
      // "try a demo account" hint.
      try {
        const res = await fetch('/api/me')
        const data = await res.json()
        if (data.authenticated && data.owner?.id) {
          setOwnerId(data.owner.id)
          setOwnerMeta({ saccoName: data.sacco.name, region: data.sacco.region })
        } else {
          setOwnerId(null)
        }
        if (data.demoOwners?.length) {
          setOwnerList(data.demoOwners)
        }
      } catch (e) {
        console.error('Failed to fetch /api/me', e)
      }
      await fetchBusData()
      await fetchGpsData()
      setLoading(false)
    }
    load()
  }, [])

  // Whenever the NextAuth session changes (login / logout), re-sync.
  useEffect(() => {
    if (sessionOwnerId) {
      setOwnerId(sessionOwnerId)
    } else if (status === 'unauthenticated') {
      // Don't wipe ownerId on initial loading state — only when we
      // definitively know the user is signed out.
      setOwnerId(null)
    }
  }, [sessionOwnerId, status])

  // ─── Sign-in handler ───────────────────────────────────────────
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!signInEmail || !signInPassword) {
      toast.error('Email and password are required')
      return
    }
    setSignInLoading(true)
    try {
      const result = await signIn('credentials', {
        email: signInEmail,
        password: signInPassword,
        redirect: false,
      })
      if (result?.error) {
        toast.error('Invalid email or password')
      } else {
        toast.success('Signed in!')
        // Force a session refresh — NextAuth's useSession will pick
        // this up automatically, but we also reload to be safe.
        setTimeout(() => window.location.reload(), 400)
      }
    } catch (err) {
      toast.error('Sign-in failed')
    } finally {
      setSignInLoading(false)
    }
  }

  const handleSignOut = async () => {
    await signOut({ redirect: false })
    setOwnerId(null)
    setBusData(null)
    setTripData(null)
    setFleetData(null)
    toast.info('Signed out')
  }

  // When ownerId changes, fetch the SACCO's bus list and refresh fleet
  useEffect(() => {
    if (!ownerId) return
    const loadSacco = async () => {
      try {
        const res = await fetch(`/api/buses?ownerId=${encodeURIComponent(ownerId)}`)
        const data = await res.json()
        if (data.buses) {
          const simplified = data.buses.map((b: any) => ({
            id: b.id,
            name: b.name,
            registrationNumber: b.registrationNumber,
            totalSeats: b.totalSeats,
            layoutType: b.layoutType,
            routeName: b.route?.name ?? null,
            routeCode: b.route?.code ?? null,
          }))
          setBusList(simplified)
          // If currently-selected bus isn't in this SACCO, switch to first
          if (!selectedBusId || !simplified.find((b: any) => b.id === selectedBusId)) {
            setSelectedBusId(simplified[0]?.id ?? null)
          }
          setOwnerMeta({ saccoName: data.sacco.name, region: data.sacco.region })
        }
      } catch (e) {
        console.error('Failed to fetch buses for SACCO', e)
      }
    }
    loadSacco()
  }, [ownerId])

  // When selectedBusId changes (or ownerId), refetch bus/trip/gps data
  useEffect(() => {
    if (selectedBusId) {
      fetchBusData().then(() => fetchGpsData())
      // Also re-join the new bus's WS room
      if (socketRef.current?.connected) {
        socketRef.current.emit('join_bus', selectedBusId)
      }
    }
  }, [selectedBusId, ownerId, fetchBusData, fetchGpsData])

  // ─── WebSocket ────────────────────────────────────────────────
  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    socket.on('connect', () => {
      console.log('[WS] Connected')
      // Will join bus after busData loads
    })

    socket.on('bus_state', (state: any) => {
      if (state.notifications) {
        setNotifications(prev => {
          const merged = [...state.notifications, ...prev]
          const seen = new Set<string>()
          return merged.filter(n => {
            if (seen.has(n.id)) return false
            seen.add(n.id)
            return true
          }).slice(0, 50)
        })
      }
    })

    socket.on('passenger_boarded', (data: any) => {
      toast.success(`🚌 ${data.name || 'Passenger'} boarded — Seat ${data.seatNumber}`, {
        description: `Alighting at ${data.alightingStop}`,
      })
      fetchBusData()
    })

    socket.on('passenger_alighted', (data: any) => {
      toast.info(`👋 Seat ${data.seatNumber} is now free`, {
        description: 'Passenger alighted',
      })
      fetchBusData()
      fetchTripData()
    })

    socket.on('payment_update', () => {
      fetchBusData()
      fetchTripData()
    })

    socket.on('advance_stop', () => {
      fetchBusData()
      fetchTripData()
    })

    socket.on('notification', (notif: WSNotification) => {
      setNotifications(prev => [notif, ...prev].slice(0, 50))
      if (notif.type === 'crew_broadcast') {
        toast.info(`📢 ${notif.message}`)
      } else if (notif.type === 'payment_alert') {
        toast.error(`⚠️ ${notif.message}`)
      }
    })

    socket.on('gps_update', (data: { busId: string; lat: number; lng: number; speed: number; heading: number; timestamp: string }) => {
      setGpsData(prev => prev ? {
        ...prev,
        currentLocation: { lat: data.lat, lng: data.lng, speed: data.speed, heading: data.heading, timestamp: data.timestamp },
        speed: data.speed,
        heading: data.heading,
        lastUpdated: data.timestamp,
        gpsHistory: [...prev.gpsHistory, { lat: data.lat, lng: data.lng, speed: data.speed, heading: data.heading, timestamp: data.timestamp }].slice(-20),
      } : prev)
      // Also refresh fleet data when GPS updates (for Owner panel)
      if (activeTabRef.current === 'owner') {
        fetchFleetDataRef.current?.()
      }
    })

    // Geofence events (auto-detect stop arrival/departure)
    socket.on('geofence_event', (data: { type: string; stopIndex: number; stopName?: string; timestamp: string }) => {
      if (data.type === 'stop_arrival' && data.stopName) {
        toast.success(`📍 Arrived at ${data.stopName}`, { description: 'Geofence auto-detected' })
      }
    })

    // Off-route alerts
    socket.on('off_route_alert', (data: { distance?: number; cleared?: boolean; timestamp: string }) => {
      if (data.cleared) {
        toast.success('✅ Back on route')
      } else if (data.distance) {
        toast.error(`⚠️ Off route — ${Math.round(data.distance)}m from route!`, {
          description: 'Owner has been notified',
        })
      }
    })

    return () => {
      socket.disconnect()
    }
  }, [fetchBusData, fetchTripData])

  // Re-join bus room when busData loads
  useEffect(() => {
    if (busData?.id && socketRef.current?.connected) {
      socketRef.current.emit('join_bus', busData.id)
    }
  }, [busData?.id])

  // ─── Seed / Reset ─────────────────────────────────────────────
  const handleReset = async () => {
    try {
      await fetch('/api/seed', { method: 'POST' })
      toast.success('Database reset!', { description: 'Demo data re-seeded.' })
      await fetchBusData()
    } catch {
      toast.error('Failed to reset database')
    }
  }

  // ─── Derived data ─────────────────────────────────────────────
  const stops = busData?.route?.stops || []
  const seats = busData?.seats || []
  const currentStopIndex = tripData?.currentStopIndex || 0
  const passengersOnBoard = tripData?.passengers?.filter(p => !p.alightedAt) || []

  // ─── Tab config ───────────────────────────────────────────────
  const tabs: { key: TabType; label: string; icon: React.ReactNode }[] = [
    { key: 'passenger', label: 'Passenger', icon: <Users className="w-4 h-4" /> },
    { key: 'conductor', label: 'Conductor', icon: <UserCheck className="w-4 h-4" /> },
    { key: 'driver', label: 'Driver', icon: <Car className="w-4 h-4" /> },
    { key: 'owner', label: 'Owner', icon: <BarChart3 className="w-4 h-4" /> },
  ]

  // ─── Loading state ────────────────────────────────────────────
  if (loading || status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-blue-50/50">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-700 flex items-center justify-center animate-pulse">
            <Bus className="w-8 h-8 text-yellow-300" />
          </div>
          <h2 className="text-xl font-bold text-blue-900">MatatuLink</h2>
          <p className="text-blue-600 text-sm mt-1">Loading…</p>
        </motion.div>
      </div>
    )
  }

  // ─── Sign-in screen (unauthenticated) ────────────────────────
  if (!ownerId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-blue-800 to-blue-950 p-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md"
        >
          <div className="text-center mb-6">
            <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-yellow-400 flex items-center justify-center shadow-xl">
              <Bus className="w-8 h-8 text-blue-900" />
            </div>
            <h1 className="text-2xl font-bold text-white">MatatuLink</h1>
            <p className="text-blue-200 text-sm mt-1">Kenyan Matatu System · SACCO Owner Sign-in</p>
          </div>

          <Card className="bg-white/95 backdrop-blur shadow-2xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2 text-blue-900">
                <LogIn className="w-5 h-5 text-blue-700" />
                Sign in to your SACCO
              </CardTitle>
              <CardDescription>
                Each owner only sees their own SACCO&apos;s buses, routes, and revenue.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSignIn} className="space-y-3">
                <div>
                  <Label className="text-xs font-medium text-gray-600 flex items-center gap-1">
                    <Mail className="w-3 h-3" /> Email
                  </Label>
                  <Input
                    type="email"
                    placeholder="owner@sacco.co.ke"
                    value={signInEmail}
                    onChange={e => setSignInEmail(e.target.value)}
                    className="mt-1"
                    autoFocus
                  />
                </div>
                <div>
                  <Label className="text-xs font-medium text-gray-600 flex items-center gap-1">
                    <Lock className="w-3 h-3" /> Password
                  </Label>
                  <Input
                    type="password"
                    placeholder="••••••••"
                    value={signInPassword}
                    onChange={e => setSignInPassword(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={signInLoading}
                  className="w-full bg-blue-700 hover:bg-blue-800 text-white"
                >
                  {signInLoading ? 'Signing in…' : (
                    <>
                      <LogIn className="w-4 h-4 mr-2" />
                      Sign in
                    </>
                  )}
                </Button>
              </form>

              {ownerList.length > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
                    Demo accounts (click to prefill)
                  </p>
                  <div className="space-y-1.5">
                    {ownerList.map(o => (
                      <button
                        key={o.email}
                        onClick={() => {
                          setSignInEmail(o.email)
                          // Both demo accounts use the same password hint
                          setSignInPassword(o.region === 'Nairobi' ? 'nairobi123' : 'matatu123')
                        }}
                        className="w-full text-left p-2 rounded border border-blue-100 bg-blue-50/40 hover:bg-blue-100 transition-colors"
                      >
                        <p className="text-xs font-medium text-blue-900">{o.name} · {o.saccoName}</p>
                        <p className="text-[10px] text-gray-500">{o.email} · {o.region}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-center text-blue-300 text-xs mt-4">
            © 2026 MatatuLink · Built for Kenyan SACCOs
          </p>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50/80 to-white">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-blue-800 text-white shadow-lg">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-yellow-400 flex items-center justify-center shadow-md">
              <Bus className="w-5 h-5 text-blue-900" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">MatatuLink</h1>
              <p className="text-blue-200 text-xs">Kenyan Matatu System</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* SACCO identity (post-NextAuth login) */}
            {ownerMeta && (
              <div className="flex flex-col text-right">
                <span className="text-[10px] text-blue-200 mb-0.5 flex items-center gap-1 justify-end">
                  <Building2 className="w-3 h-3" /> SACCO
                </span>
                <span className="bg-blue-700 text-white text-xs rounded-md px-2 py-1 border border-blue-500 max-w-[200px] truncate">
                  {ownerMeta.saccoName} — {ownerMeta.region}
                </span>
              </div>
            )}

            {/* Bus selector */}
            {busList.length > 0 && (
              <div className="flex flex-col text-right">
                <label className="text-[10px] text-blue-200 mb-0.5 flex items-center gap-1 justify-end">
                  <Bus className="w-3 h-3" /> Active Bus
                </label>
                <select
                  value={selectedBusId ?? ''}
                  onChange={(e) => setSelectedBusId(e.target.value)}
                  className="bg-blue-700 text-white text-xs rounded-md px-2 py-1 border border-blue-500 max-w-[200px]"
                >
                  {busList.map(b => (
                    <option key={b.id} value={b.id} className="text-black">
                      {b.registrationNumber} ({b.totalSeats}p)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Sign-out */}
            <Button
              onClick={handleSignOut}
              size="sm"
              variant="outline"
              className="bg-yellow-400 hover:bg-yellow-300 text-blue-900 border-yellow-300 font-semibold"
            >
              <LogOut className="w-3.5 h-3.5 mr-1" />
              Sign out
            </Button>
          </div>
        </div>

        {/* Secondary bar: route + active bus summary */}
        {busData && (
          <div className="bg-blue-900/50 border-t border-blue-600">
            <div className="max-w-5xl mx-auto px-4 py-1.5 flex items-center justify-between text-xs text-blue-100 flex-wrap gap-1">
              <span className="flex items-center gap-1.5">
                <RouteIcon className="w-3 h-3" />
                {busData.route?.code ? `Route ${busData.route.code}` : 'No code'} • {busData.route?.name || 'No route assigned'}
              </span>
              <span>
                {busData.registrationNumber} • {busData.totalSeats} seats ({busData.layoutType?.replace('_', ' ')})
              </span>
            </div>
          </div>
        )}
      </header>

      {/* ─── Tab Bar ────────────────────────────────────────────── */}
      <div className="sticky top-[60px] z-40 bg-white border-b shadow-sm">
        <div className="max-w-5xl mx-auto px-2">
          <div className="flex">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => {
                  setActiveTab(tab.key)
                  if (tab.key === 'owner') fetchFleetData()
                }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium transition-all border-b-2 ${
                  activeTab === tab.key
                    ? 'border-blue-700 text-blue-800 bg-blue-50/60'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                {tab.icon}
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Broadcast Banner ────────────────────────────────────── */}
      {notifications.filter(n => n.type === 'crew_broadcast').length > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2">
          <div className="max-w-5xl mx-auto flex items-center gap-2">
            <Radio className="w-4 h-4 text-amber-600 shrink-0" />
            <p className="text-amber-800 text-sm font-medium truncate">
              {notifications.find(n => n.type === 'crew_broadcast')?.message}
            </p>
          </div>
        </div>
      )}

      {/* ─── Content ────────────────────────────────────────────── */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'passenger' && (
              <PassengerPanel
                busData={busData}
                tripData={tripData}
                stops={stops}
                seats={seats}
                currentStopIndex={currentStopIndex}
                gpsData={gpsData}
                emitSocket={emitSocket}
                onRefresh={fetchBusData}
              />
            )}
            {activeTab === 'conductor' && (
              <ConductorPanel
                busData={busData}
                tripData={tripData}
                stops={stops}
                seats={seats}
                currentStopIndex={currentStopIndex}
                emitSocket={emitSocket}
                notifications={notifications}
                onRefresh={fetchBusData}
              />
            )}
            {activeTab === 'driver' && (
              <DriverPanel
                busData={busData}
                tripData={tripData}
                stops={stops}
                seats={seats}
                currentStopIndex={currentStopIndex}
                passengersOnBoard={passengersOnBoard}
                gpsData={gpsData}
                emitSocket={emitSocket}
                notifications={notifications}
                onRefresh={() => { fetchBusData(); fetchTripData() }}
                fetchGpsData={fetchGpsData}
              />
            )}
            {activeTab === 'owner' && (
              <OwnerPanel
                busData={busData}
                tripData={tripData}
                stops={stops}
                seats={seats}
                currentStopIndex={currentStopIndex}
                transactions={transactions}
                gpsData={gpsData}
                fleetData={fleetData}
                ownerId={ownerId}
                onRefresh={() => { fetchBusData(); fetchFleetData() }}
                onReset={handleReset}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ─── Footer ──────────────────────────────────────────────── */}
      <footer className="mt-auto border-t bg-white py-3">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between text-xs text-gray-500">
          <span>© 2026 MatatuLink</span>
          <button
            onClick={handleReset}
            className="flex items-center gap-1 text-gray-400 hover:text-red-500 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Reset Demo
          </button>
        </div>
      </footer>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// PASSENGER PANEL
// ═══════════════════════════════════════════════════════════════════
function PassengerPanel({
  busData,
  tripData,
  stops,
  seats,
  currentStopIndex,
  gpsData,
  emitSocket,
  onRefresh,
}: {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  gpsData: GPSData | null
  emitSocket: (event: string, data: any) => void
  onRefresh: () => void
}) {
  const [step, setStep] = useState(1)
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null)
  const [selectedStop, setSelectedStop] = useState<string>('')
  const [customStop, setCustomStop] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<string>('')
  const [mpesaPhone, setMpesaPhone] = useState('')
  const [processing, setProcessing] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const selectedStopData = stops.find(s => s.name === selectedStop)
  // Fare matrix: fare = (alightingStop.fareFromOrigin) − (boardingStop.fareFromOrigin).
  // For custom (free-text) alighting, default to the last stop's fare.
  const usingCustom = customStop.trim().length > 0
  const fare = computeFare(stops, currentStopIndex, usingCustom ? null : selectedStop, usingCustom)

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
      const res = await fetch('/api/passengers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        }),
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
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="flex flex-col items-center justify-center py-16"
      >
        <motion.div
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ duration: 0.5, repeat: 2 }}
          className="w-20 h-20 rounded-full bg-blue-100 flex items-center justify-center mb-6"
        >
          <CheckCircle2 className="w-10 h-10 text-blue-600" />
        </motion.div>
        <h2 className="text-2xl font-bold text-blue-800 mb-2">You&apos;re all set! 🎉</h2>
        <p className="text-gray-600">Seat {selectedSeat} • {customStop || selectedStop}</p>
        <p className="text-blue-600 font-semibold mt-1">KES {fare}</p>
      </motion.div>
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

      {/* Off-route alert banner */}
      {gpsData?.isOffRoute && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-red-50 border-2 border-red-300 rounded-lg p-3 flex items-center gap-3"
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
        </motion.div>
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
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 text-center"
              >
                <Button
                  onClick={() => setStep(2)}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  Continue with Seat {selectedSeat} <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </motion.div>
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
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-2"
              >
                <label className="text-sm font-medium text-gray-700">M-Pesa Phone Number</label>
                <Input
                  placeholder="+254 7XX XXX XXX"
                  value={mpesaPhone}
                  onChange={e => setMpesaPhone(e.target.value)}
                  className="text-sm"
                />
              </motion.div>
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
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    >
                      <CreditCard className="w-4 h-4" />
                    </motion.div>
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

// ═══════════════════════════════════════════════════════════════════
// CONDUCTOR PANEL
// ═══════════════════════════════════════════════════════════════════
function ConductorPanel({
  busData,
  tripData,
  stops,
  seats,
  currentStopIndex,
  emitSocket,
  notifications,
  onRefresh,
}: {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  emitSocket: (event: string, data: any) => void
  notifications: WSNotification[]
  onRefresh: () => void
}) {
  const [boardSeat, setBoardSeat] = useState('')
  const [boardName, setBoardName] = useState('')
  const [boardPhone, setBoardPhone] = useState('')
  const [boardAlighting, setBoardAlighting] = useState('')
  const [boardCustomStop, setBoardCustomStop] = useState('')
  const [boardFare, setBoardFare] = useState('')
  const [boardPayMethod, setBoardPayMethod] = useState('')
  const [boarding, setBoarding] = useState(false)
  const [broadcastText, setBroadcastText] = useState('')
  const [selectedSeatDialog, setSelectedSeatDialog] = useState<Seat | null>(null)

  const availableSeats = seats.filter(s => !s.isOccupied)
  const passengersOnBoard = tripData?.passengers?.filter(p => !p.alightedAt) || []
  const approachingPassengers = passengersOnBoard.filter(
    p => p.alightingStopOrder <= currentStopIndex + 2
  )

  // When conductor picks an alighting stop from the dropdown, auto-suggest
  // the fare from the matrix. They can still override the input afterwards.
  useEffect(() => {
    if (boardAlighting) {
      const suggested = computeFare(stops, currentStopIndex, boardAlighting, false)
      setBoardFare(String(suggested))
    }
  }, [boardAlighting, stops, currentStopIndex])

  // When custom stop is typed, default to end-of-route fare
  useEffect(() => {
    if (boardCustomStop.trim()) {
      const suggested = computeFare(stops, currentStopIndex, null, true)
      setBoardFare(String(suggested))
    }
  }, [boardCustomStop, stops, currentStopIndex])

  const handleBoard = async () => {
    const usingCustom = boardCustomStop.trim().length > 0
    if (!boardSeat || (!boardAlighting && !usingCustom) || !boardFare) {
      toast.error('Please fill in required fields (seat, alighting stop, and fare)')
      return
    }
    setBoarding(true)
    try {
      const alightingStopData = stops.find(s => s.name === boardAlighting)
      const stopOrder = usingCustom
        ? (stops[stops.length - 1]?.order ?? 1)
        : (alightingStopData?.order || 1)
      const finalAlighting = usingCustom ? boardCustomStop.trim() : boardAlighting
      const res = await fetch('/api/passengers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: boardName || null,
          phone: boardPhone || null,
          seatNumber: parseInt(boardSeat),
          boardingStop: stops[currentStopIndex]?.name || 'Unknown',
          alightingStop: finalAlighting,
          alightingStopOrder: stopOrder,
          isCustomAlighting: usingCustom,
          fare: parseFloat(boardFare),
          paymentMethod: boardPayMethod || null,
          busId: busData?.id,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Failed to board passenger')
        setBoarding(false)
        return
      }

      if (busData?.id) {
        emitSocket('passenger_boarded', {
          busId: busData.id,
          passenger: {
            id: data.passenger?.id || 'new',
            name: boardName || null,
            phone: boardPhone || null,
            seatNumber: parseInt(boardSeat),
            boardingStop: stops[currentStopIndex]?.name || 'Unknown',
            alightingStop: finalAlighting,
            alightingStopOrder: stopOrder,
            isCustomAlighting: usingCustom,
            fare: parseFloat(boardFare),
            paymentStatus: boardPayMethod ? 'paid' : 'unpaid',
            paymentMethod: boardPayMethod || null,
            boardedAt: new Date().toISOString(),
          },
        })
      }

      toast.success(`Passenger boarded — Seat ${boardSeat}`)
      setBoardSeat('')
      setBoardName('')
      setBoardPhone('')
      setBoardAlighting('')
      setBoardCustomStop('')
      setBoardFare('')
      setBoardPayMethod('')
      onRefresh()
    } catch {
      toast.error('Failed to board passenger')
    }
    setBoarding(false)
  }

  const handleAlight = async (passengerId: string, seatNumber: number) => {
    try {
      const res = await fetch('/api/passengers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passengerId, action: 'alight' }),
      })
      const data = await res.json()

      if (data.blocked) {
        toast.error('⚠️ Cannot alight — fare not paid!', {
          description: 'Collect payment first before allowing alight.',
        })
        return
      }

      if (busData?.id) {
        emitSocket('confirm_alight', {
          busId: busData.id,
          passengerId,
          seatNumber,
          paid: true,
        })
      }

      toast.success(`Seat ${seatNumber} is now free`)
      onRefresh()
    } catch {
      toast.error('Failed to process alighting')
    }
  }

  const handleMarkPaid = async (passengerId: string, fare: number) => {
    try {
      await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passengerId, method: 'cash', amount: fare }),
      })
      if (busData?.id) {
        emitSocket('payment_update', {
          busId: busData.id,
          passengerId,
          status: 'paid',
          method: 'cash',
        })
      }
      toast.success('Payment marked as received')
      onRefresh()
    } catch {
      toast.error('Failed to mark payment')
    }
  }

  const handleBroadcast = () => {
    if (broadcastText.trim() && busData?.id) {
      emitSocket('broadcast_message', {
        busId: busData.id,
        message: broadcastText,
        from: 'conductor',
      })
      setBroadcastText('')
      toast.success('Broadcast sent!')
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left: Seat Map + Board Passenger */}
      <div className="lg:col-span-2 space-y-6">
        {/* Seat Map */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Armchair className="w-5 h-5 text-blue-600" />
              Seat Map
            </CardTitle>
            <CardDescription>
              <span className="flex flex-wrap items-center gap-2 text-xs mt-1">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-100 border border-blue-400" /> Free</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 border border-red-400" /> Alighting soon</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-100 border border-orange-400" /> Far stop</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-100 border border-yellow-500 border-dashed" /> Unpaid</span>
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Layout-aware seat grid: uses row/col when available so the
                33-seater Coaster renders correctly with its aisle. */}
            {(() => {
              // If all seats have row/col, render as absolute-positioned grid by row/col
              const hasLayout = seats.every(s => s.row !== undefined && s.col !== undefined)
              if (hasLayout) {
                const maxRow = Math.max(...seats.map(s => s.row as number))
                const maxCol = Math.max(...seats.map(s => s.col as number))
                const seatsByRowCol = new Map<string, Seat>()
                seats.forEach(s => seatsByRowCol.set(`${s.row}-${s.col}`, s))
                return (
                  <div className="overflow-x-auto">
                    <div
                      className="grid gap-1.5 mx-auto"
                      style={{
                        gridTemplateColumns: `repeat(${maxCol}, minmax(28px, 36px))`,
                        gridTemplateRows: `repeat(${maxRow}, minmax(32px, 40px))`,
                        width: 'fit-content',
                      }}
                    >
                      {Array.from({ length: maxRow }).map((_, rIdx) =>
                        Array.from({ length: maxCol }).map((__, cIdx) => {
                          const seat = seatsByRowCol.get(`${rIdx + 1}-${cIdx + 1}`)
                          if (!seat) return <div key={`${rIdx}-${cIdx}`} />
                          const color = getSeatColor(seat, currentStopIndex)
                          const isClickable = seat.isOccupied
                          return (
                            <Dialog key={seat.id}>
                              <DialogTrigger asChild>
                                <button
                                  className={`p-1 rounded-lg border-2 text-center transition-all text-xs font-medium ${color} ${
                                    isClickable ? 'cursor-pointer hover:shadow-md' : ''
                                  }`}
                                  onClick={() => isClickable && setSelectedSeatDialog(seat)}
                                  title={`Seat ${seat.number}`}
                                >
                                  <Armchair className="w-3 h-3 mx-auto mb-0.5" />
                                  <span className="block">{seat.number}</span>
                                  {seat.passenger && (
                                    <span className="block text-[8px] truncate opacity-70">
                                      {seat.passenger.name || '---'}
                                    </span>
                                  )}
                                </button>
                              </DialogTrigger>
                              {isClickable && selectedSeatDialog?.id === seat.id && seat.passenger && (
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Seat {seat.number}</DialogTitle>
                                    <DialogDescription>Passenger details</DialogDescription>
                                  </DialogHeader>
                                  <div className="space-y-3">
                                    <div className="grid grid-cols-2 gap-2 text-sm">
                                      <div>
                                        <p className="text-gray-500">Name</p>
                                        <p className="font-medium">{seat.passenger.name || 'Unknown'}</p>
                                      </div>
                                      <div>
                                        <p className="text-gray-500">Phone</p>
                                        <p className="font-medium">{seat.passenger.phone || '—'}</p>
                                      </div>
                                      <div>
                                        <p className="text-gray-500">Boarding</p>
                                        <p className="font-medium">{seat.passenger.boardingStop}</p>
                                      </div>
                                      <div>
                                        <p className="text-gray-500">Alighting</p>
                                        <p className="font-medium flex items-center gap-1.5 flex-wrap">
                                          {seat.passenger.alightingStop}
                                          {seat.passenger.isCustomAlighting && (
                                            <Badge className="bg-yellow-400 text-yellow-900 border-yellow-500 text-[10px]">
                                              CUSTOM DROP-OFF
                                            </Badge>
                                          )}
                                        </p>
                                        {seat.passenger.isCustomAlighting && (
                                          <p className="text-[10px] text-yellow-700 mt-0.5">
                                            Landmark the driver knows — not on the registered route.
                                          </p>
                                        )}
                                      </div>
                                      <div>
                                        <p className="text-gray-500">Fare</p>
                                        <p className="font-medium">KES {seat.passenger.fare}</p>
                                      </div>
                                      <div>
                                        <p className="text-gray-500">Payment</p>
                                        <p className="font-medium capitalize">{seat.passenger.paymentStatus}</p>
                                      </div>
                                    </div>
                                    <Button
                                      className="w-full bg-blue-600 hover:bg-blue-700"
                                      onClick={() => handleAlight(seat.passenger!.id, seat.number)}
                                    >
                                      <UserCheck className="w-4 h-4 mr-2" />
                                      Alight Passenger
                                    </Button>
                                  </div>
                                </DialogContent>
                              )}
                            </Dialog>
                          )
                        })
                      )}
                    </div>
                    <p className="text-[10px] text-gray-400 text-center mt-2">
                      {seats.length} seats · {maxRow} rows × {maxCol} cols (with aisle)
                    </p>
                  </div>
                )
              }
              // Fallback: simple flat grid
              return (
                <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
                  {seats.map(seat => {
                    const color = getSeatColor(seat, currentStopIndex)
                    const isClickable = seat.isOccupied
                    return (
                      <Dialog key={seat.id}>
                        <DialogTrigger asChild>
                          <button
                            className={`p-2 rounded-lg border-2 text-center transition-all text-xs font-medium ${color} ${
                              isClickable ? 'cursor-pointer hover:shadow-md' : ''
                            }`}
                            onClick={() => isClickable && setSelectedSeatDialog(seat)}
                          >
                            <Armchair className="w-3 h-3 mx-auto mb-0.5" />
                            <span className="block">{seat.number}</span>
                            {seat.passenger && (
                              <span className="block text-[10px] truncate opacity-70">
                                {seat.passenger.name || '---'}
                              </span>
                            )}
                          </button>
                        </DialogTrigger>
                        {isClickable && selectedSeatDialog?.id === seat.id && seat.passenger && (
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Seat {seat.number}</DialogTitle>
                              <DialogDescription>Passenger details</DialogDescription>
                            </DialogHeader>
                            <div className="space-y-3">
                              <div className="grid grid-cols-2 gap-2 text-sm">
                                <div>
                                  <p className="text-gray-500">Name</p>
                                  <p className="font-medium">{seat.passenger.name || 'Unknown'}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500">Phone</p>
                                  <p className="font-medium">{seat.passenger.phone || '—'}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500">Boarding</p>
                                  <p className="font-medium">{seat.passenger.boardingStop}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500">Alighting</p>
                                  <p className="font-medium">{seat.passenger.alightingStop}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500">Fare</p>
                                  <p className="font-medium">KES {seat.passenger.fare}</p>
                                </div>
                                <div>
                                  <p className="text-gray-500">Payment</p>
                                  <p className="font-medium capitalize">{seat.passenger.paymentStatus}</p>
                                </div>
                              </div>
                              <Button
                                className="w-full bg-blue-600 hover:bg-blue-700"
                                onClick={() => handleAlight(seat.passenger!.id, seat.number)}
                              >
                                <UserCheck className="w-4 h-4 mr-2" />
                                Alight Passenger
                              </Button>
                            </div>
                          </DialogContent>
                        )}
                      </Dialog>
                    )
                  })}
                </div>
              )
            })()}
          </CardContent>
        </Card>

        {/* Board New Passenger */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <User className="w-5 h-5 text-blue-600" />
              Board New Passenger
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600">Seat Number *</label>
                <Select value={boardSeat} onValueChange={setBoardSeat}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select seat" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSeats.map(s => (
                      <SelectItem key={s.id} value={s.number.toString()}>
                        Seat {s.number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Passenger Name</label>
                <Input placeholder="e.g., Amina S." value={boardName} onChange={e => setBoardName(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Phone Number</label>
                <Input placeholder="+254 7XX XXX XXX" value={boardPhone} onChange={e => setBoardPhone(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Boarding Stop</label>
                <Input value={stops[currentStopIndex]?.name || 'Current Stop'} disabled className="mt-1 bg-gray-50" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Alighting Stop *</label>
                <Select value={boardAlighting} onValueChange={setBoardAlighting}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select stop" />
                  </SelectTrigger>
                  <SelectContent>
                    {stops.filter(s => s.order > currentStopIndex).map(s => (
                      <SelectItem key={s.id} value={s.name}>
                        {s.order}. {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Or Custom Stop</label>
                <Input placeholder="Custom stop name" value={boardCustomStop} onChange={e => setBoardCustomStop(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Fare (KES) *</label>
                <Input type="number" placeholder="e.g., 80" value={boardFare} onChange={e => setBoardFare(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Payment Method</label>
                <Select value={boardPayMethod} onValueChange={setBoardPayMethod}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select method" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mpesa">M-Pesa</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="qr">QR Code</SelectItem>
                    <SelectItem value="nfc">NFC</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              onClick={handleBoard}
              disabled={boarding || !boardSeat || !boardAlighting || !boardFare}
              className="bg-blue-600 hover:bg-blue-700 mt-4 w-full"
            >
              {boarding ? 'Boarding...' : 'Board Passenger'}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Right: Alighting Control + Quick Actions + Notifications */}
      <div className="space-y-6">
        {/* Alighting Control */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Navigation className="w-5 h-5 text-red-500" />
              Approaching Stops
            </CardTitle>
          </CardHeader>
          <CardContent>
            {approachingPassengers.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No passengers approaching stops</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
                {approachingPassengers.map(p => (
                  <div
                    key={p.id}
                    className={`p-3 rounded-lg border-2 ${
                      p.isCustomAlighting
                        ? 'border-yellow-400 bg-yellow-50'
                        : p.alightingStopOrder <= currentStopIndex + 1
                        ? 'border-red-300 bg-red-50'
                        : 'border-amber-300 bg-amber-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="font-medium text-sm">{p.name || 'Passenger'}</p>
                        <p className="text-xs text-gray-600">
                          Seat {p.seat?.number} → {p.alightingStop}
                        </p>
                        {p.isCustomAlighting && (
                          <Badge className="bg-yellow-400 text-yellow-900 border-yellow-500 text-[9px] mt-1">
                            CUSTOM DROP-OFF
                          </Badge>
                        )}
                      </div>
                      <Badge variant={p.paymentStatus === 'paid' ? 'default' : 'destructive'} className="text-xs">
                        {p.paymentStatus}
                      </Badge>
                    </div>
                    <div className="flex gap-2 mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleAlight(p.id, p.seat?.number || 0)}
                        className="text-xs"
                      >
                        Confirm Alight
                      </Button>
                      {p.paymentStatus !== 'paid' && (
                        <Button
                          size="sm"
                          onClick={() => handleMarkPaid(p.id, p.fare)}
                          className="bg-blue-700 hover:bg-blue-800 text-xs"
                        >
                          Mark Paid
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-blue-600" />
              Broadcast Message
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Message to all passengers..."
              value={broadcastText}
              onChange={e => setBroadcastText(e.target.value)}
            />
            <Button
              onClick={handleBroadcast}
              disabled={!broadcastText.trim()}
              className="bg-blue-600 hover:bg-blue-700 w-full"
            >
              <Send className="w-4 h-4 mr-2" />
              Send Broadcast
            </Button>
          </CardContent>
        </Card>

        {/* Notification Feed */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <BellIcon className="w-5 h-5 text-blue-600" />
              Notifications
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
              {notifications.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No notifications yet</p>
              ) : (
                notifications.slice(0, 20).map(n => (
                  <div key={n.id} className="p-2 rounded bg-gray-50 text-xs">
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
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// DRIVER PANEL
// ═══════════════════════════════════════════════════════════════════
function DriverPanel({
  busData,
  tripData,
  stops,
  seats,
  currentStopIndex,
  passengersOnBoard,
  gpsData,
  emitSocket,
  notifications,
  onRefresh,
  fetchGpsData,
}: {
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
}) {
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
                <motion.div
                  key={n.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`p-2 rounded text-xs ${
                    n.type === 'payment_alert' ? 'bg-red-50 border border-red-200' :
                    n.type === 'crew_broadcast' ? 'bg-amber-50 border border-amber-200' :
                    'bg-gray-50'
                  }`}
                >
                  <p className="font-medium">{n.message}</p>
                  <p className="text-gray-400 mt-0.5">
                    {new Date(n.timestamp).toLocaleTimeString()}
                  </p>
                </motion.div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE MANAGER — let each SACCO register their own numbered routes
//   Two ways to enter stops: paste-as-text OR upload a CSV file.
// ═══════════════════════════════════════════════════════════════════
function RouteManager({ ownerId, onRoutesChanged }: { ownerId: string | null; onRoutesChanged: () => void }) {
  const [routes, setRoutes] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  // 'text' = paste stops in a textarea, 'csv' = upload a .csv file
  const [inputMode, setInputMode] = useState<'text' | 'csv'>('text')

  // Form state
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [region, setRegion] = useState('')
  const [stopsText, setStopsText] = useState('')
  const [csvFileName, setCsvFileName] = useState('')
  const [csvParsedStops, setCsvParsedStops] = useState<Array<{ name: string; lat: number; lng: number; isStage: boolean; fareFromOrigin: number }> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchRoutes = useCallback(async () => {
    if (!ownerId) return
    try {
      const res = await fetch(`/api/routes?ownerId=${encodeURIComponent(ownerId)}`)
      const data = await res.json()
      if (data.routes) setRoutes(data.routes)
    } catch (e) {
      console.error('Failed to fetch routes', e)
    }
  }, [ownerId])

  useEffect(() => {
    fetchRoutes()
  }, [fetchRoutes])

  const parseStops = (text: string): Array<{ name: string; lat: number; lng: number; isStage: boolean; fareFromOrigin: number }> => {
    // Each non-empty line: "Name, lat, lng, [isStage], [fareFromOrigin]"
    return text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split(',').map(s => s.trim())
        if (parts.length < 3) throw new Error(`Bad line: "${line}". Use: Name, lat, lng, [isStage], [fare]`)
        const lat = parseFloat(parts[1])
        const lng = parseFloat(parts[2])
        if (Number.isNaN(lat) || Number.isNaN(lng)) throw new Error(`Invalid lat/lng on: "${line}"`)
        return {
          name: parts[0],
          lat,
          lng,
          isStage: parts[3] ? parts[3].toLowerCase() === 'true' || parts[3] === '1' : true,
          fareFromOrigin: parts[4] ? parseFloat(parts[4]) || 0 : 0,
        }
      })
  }

  /**
   * Parse a CSV file into stops. Accepts either:
   *   - With header row: name,lat,lng,isStage,fareFromOrigin
   *   - Without header: just rows of values in that column order.
   * Quoted CSV values are tolerated (e.g. "Tena, Junction",-1.26,...).
   */
  const parseCsvText = (csv: string): Array<{ name: string; lat: number; lng: number; isStage: boolean; fareFromOrigin: number }> => {
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    if (!lines.length) throw new Error('CSV file is empty')

    // Tiny CSV row parser: handles quoted values with embedded commas
    const splitRow = (row: string): string[] => {
      const out: string[] = []
      let cur = ''
      let inQuotes = false
      for (let i = 0; i < row.length; i++) {
        const c = row[i]
        if (c === '"') {
          if (inQuotes && row[i + 1] === '"') { cur += '"'; i++ }
          else inQuotes = !inQuotes
        } else if (c === ',' && !inQuotes) {
          out.push(cur); cur = ''
        } else {
          cur += c
        }
      }
      out.push(cur)
      return out.map(s => s.trim())
    }

    const firstRow = splitRow(lines[0])
    const looksLikeHeader = firstRow.some(c => /name|lat|lng|stage|fare/i.test(c))
    const dataRows = looksLikeHeader ? lines.slice(1) : lines

    return dataRows.map((line, i) => {
      const parts = splitRow(line)
      if (parts.length < 3) throw new Error(`Row ${i + (looksLikeHeader ? 2 : 1)}: need at least 3 columns (name, lat, lng)`)
      const lat = parseFloat(parts[1])
      const lng = parseFloat(parts[2])
      if (Number.isNaN(lat) || Number.isNaN(lng)) throw new Error(`Row ${i + (looksLikeHeader ? 2 : 1)}: invalid lat/lng "${parts[1]}, ${parts[2]}"`)
      return {
        name: parts[0],
        lat,
        lng,
        isStage: parts[3] ? parts[3].toLowerCase() === 'true' || parts[3] === '1' : true,
        fareFromOrigin: parts[4] ? parseFloat(parts[4]) || 0 : 0,
      }
    })
  }

  const handleCsvUpload = async (file: File) => {
    setError(null)
    try {
      const text = await file.text()
      const parsed = parseCsvText(text)
      if (parsed.length < 2) {
        setError('CSV must contain at least 2 stops')
        setCsvParsedStops(null)
        setCsvFileName('')
        return
      }
      setCsvParsedStops(parsed)
      setCsvFileName(file.name)
      // Also mirror into stopsText so the user can preview/edit
      setStopsText(parsed.map(s => `${s.name}, ${s.lat}, ${s.lng}, ${s.isStage}, ${s.fareFromOrigin}`).join('\n'))
      toast.success(`Parsed ${parsed.length} stops from ${file.name}`)
    } catch (e: any) {
      setError(e.message || 'Failed to parse CSV')
      setCsvParsedStops(null)
      setCsvFileName('')
    }
  }

  const handleCreate = async () => {
    setError(null)
    if (!ownerId) return
    if (!name.trim()) { setError('Route name is required'); return }
    try {
      let stops: Array<{ name: string; lat: number; lng: number; isStage: boolean; fareFromOrigin: number }>
      if (inputMode === 'csv' && csvParsedStops) {
        stops = csvParsedStops
      } else {
        stops = parseStops(stopsText)
      }
      if (stops.length < 2) { setError('Provide at least 2 stops'); return }

      setLoading(true)
      const res = await fetch(`/api/routes?ownerId=${encodeURIComponent(ownerId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, code, region: region || undefined, stops }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to create route')
        setLoading(false)
        return
      }
      toast.success(`Route "${name}" created with ${stops.length} stops`)
      setName(''); setCode(''); setStopsText(''); setCsvParsedStops(null); setCsvFileName('')
      setShowForm(false)
      await fetchRoutes()
      onRoutesChanged()
    } catch (e: any) {
      setError(e.message || 'Failed to parse stops')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <RouteIcon className="w-5 h-5 text-blue-700" />
            Route Manager
            <Badge variant="outline" className="text-xs ml-1">{routes.length} routes</Badge>
          </CardTitle>
          <Button
            size="sm"
            onClick={() => setShowForm(s => !s)}
            className="bg-blue-700 hover:bg-blue-800"
          >
            <Plus className="w-4 h-4 mr-1" />
            {showForm ? 'Cancel' : 'Register Route'}
          </Button>
        </div>
        <CardDescription>
          Each SACCO registers its own routes with a Nairobi-style numbered code (e.g. 33, 110, 237) plus stop coordinates. Stops power the geofencing + ETA engine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showForm && (
          <div className="border-2 border-blue-200 rounded-lg p-3 bg-blue-50/40 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <Label className="text-xs">Route Name *</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Umoja → CBD" />
              </div>
              <div>
                <Label className="text-xs">Route Code</Label>
                <Input value={code} onChange={e => setCode(e.target.value)} placeholder="33" />
              </div>
              <div>
                <Label className="text-xs">Region</Label>
                <Input value={region} onChange={e => setRegion(e.target.value)} placeholder="Nairobi" />
              </div>
            </div>

            {/* Input-mode toggle: Text vs CSV upload */}
            <div>
              <Label className="text-xs mb-1.5 block">Stops input method</Label>
              <div className="flex gap-1.5 mb-2">
                <button
                  onClick={() => setInputMode('text')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border-2 transition-all ${
                    inputMode === 'text'
                      ? 'bg-blue-700 text-white border-blue-700'
                      : 'bg-white text-blue-700 border-blue-200 hover:border-blue-400'
                  }`}
                >
                  Paste text
                </button>
                <button
                  onClick={() => setInputMode('csv')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border-2 transition-all flex items-center gap-1.5 ${
                    inputMode === 'csv'
                      ? 'bg-blue-700 text-white border-blue-700'
                      : 'bg-white text-blue-700 border-blue-200 hover:border-blue-400'
                  }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  Upload CSV
                </button>
              </div>
            </div>

            {inputMode === 'text' ? (
              <div>
                <Label className="text-xs">
                  Stops (one per line): <code className="bg-white px-1 rounded">Name, lat, lng, [isStage], [fareFromOrigin]</code>
                </Label>
                <Textarea
                  value={stopsText}
                  onChange={e => setStopsText(e.target.value)}
                  rows={6}
                  placeholder={'Umoja Innercore, -1.2700, 36.8900, true, 0\nUmoja Market, -1.2680, 36.8830, true, 20\nTena, -1.2640, 36.8750, true, 40'}
                  className="font-mono text-xs"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="text-xs">
                  CSV columns: <code className="bg-white px-1 rounded">name, lat, lng, [isStage], [fareFromOrigin]</code>
                </Label>
                <label
                  htmlFor="csv-upload"
                  className="flex flex-col items-center justify-center border-2 border-dashed border-blue-300 rounded-lg p-5 cursor-pointer hover:bg-blue-50 transition-colors"
                >
                  <Upload className="w-6 h-6 text-blue-600 mb-2" />
                  <span className="text-sm font-medium text-blue-800">
                    {csvFileName ? `✓ ${csvFileName}` : 'Click to choose a .csv file'}
                  </span>
                  <span className="text-[10px] text-gray-500 mt-1">
                    Header row optional. Quoted values supported.
                  </span>
                  <input
                    id="csv-upload"
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) handleCsvUpload(f)
                    }}
                  />
                </label>
                {csvParsedStops && csvParsedStops.length > 0 && (
                  <div className="text-xs text-blue-800 bg-blue-100/60 rounded p-2">
                    <p className="font-medium mb-1">Parsed {csvParsedStops.length} stops:</p>
                    <div className="max-h-32 overflow-y-auto custom-scrollbar space-y-0.5">
                      {csvParsedStops.slice(0, 12).map((s, i) => (
                        <div key={i} className="font-mono">
                          {i + 1}. {s.name} · {s.lat}, {s.lng} · {s.isStage ? 'stage' : 'non-stage'} · KES {s.fareFromOrigin}
                        </div>
                      ))}
                      {csvParsedStops.length > 12 && (
                        <div className="text-gray-500">+ {csvParsedStops.length - 12} more…</div>
                      )}
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-gray-500">
                  Tip: export your stop list from Excel/Google Sheets as CSV, then upload it here. You can still tweak the values via the &quot;Paste text&quot; tab before creating the route.
                </p>
              </div>
            )}

            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</div>
            )}
            <Button onClick={handleCreate} disabled={loading} className="bg-yellow-400 hover:bg-yellow-300 text-blue-900 font-semibold">
              {loading ? 'Creating...' : `Create Route${(inputMode === 'csv' && csvParsedStops) ? ` (${csvParsedStops.length} stops)` : ''}`}
            </Button>
          </div>
        )}

        {routes.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">No routes registered yet.</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
            {routes.map(r => (
              <div key={r.id} className="border rounded-lg p-3 hover:bg-blue-50/30">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm">{r.name}</p>
                      {r.code && (
                        <Badge variant="default" className="bg-blue-100 text-blue-700 border-blue-300 text-[10px]">
                          #{r.code}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px]">{r.region}</Badge>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {r.stops?.length || 0} stops • assigned to {r.buses?.length || 0} bus(es)
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
                </div>
                {r.stops?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {r.stops.slice(0, 8).map((s: any) => (
                      <span key={s.id} className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {s.order}. {s.name}
                      </span>
                    ))}
                    {r.stops.length > 8 && (
                      <span className="text-[10px] text-gray-400 px-1">+{r.stops.length - 8} more</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// BUS MANAGER — add new buses with a layout choice (14 / 33 / 11)
// ═══════════════════════════════════════════════════════════════════
function BusManager({ ownerId, routes, onBusesChanged }: {
  ownerId: string | null
  routes: any[]
  onBusesChanged: () => void
}) {
  const [buses, setBuses] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [reg, setReg] = useState('')
  const [layout, setLayout] = useState<'matatu_14' | 'coaster_33' | 'van_11'>('matatu_14')
  const [routeId, setRouteId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchBuses = useCallback(async () => {
    if (!ownerId) return
    try {
      const res = await fetch(`/api/buses?ownerId=${encodeURIComponent(ownerId)}`)
      const data = await res.json()
      if (data.buses) setBuses(data.buses)
    } catch (e) {
      console.error('Failed to fetch buses', e)
    }
  }, [ownerId])

  useEffect(() => {
    fetchBuses()
  }, [fetchBuses])

  const handleCreate = async () => {
    setError(null)
    if (!ownerId) return
    if (!name.trim() || !reg.trim()) { setError('Name and registration are required'); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/buses?ownerId=${encodeURIComponent(ownerId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, registrationNumber: reg, layoutType: layout, routeId: routeId || undefined }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed'); setLoading(false); return }
      toast.success(`${name} added (${layout.replace('_', ' ')}, ${data.bus.totalSeats} seats)`)
      setName(''); setReg(''); setRouteId('')
      setShowForm(false)
      await fetchBuses()
      onBusesChanged()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleAssignRoute = async (busId: string, newRouteId: string) => {
    if (!ownerId) return
    try {
      await fetch(`/api/buses?ownerId=${encodeURIComponent(ownerId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ busId, routeId: newRouteId || null }),
      })
      await fetchBuses()
      onBusesChanged()
      toast.success('Bus route updated')
    } catch (e) {
      console.error(e)
    }
  }

  const layoutMeta: Record<'matatu_14' | 'coaster_33' | 'van_11', { label: string; seats: number; desc: string }> = {
    matatu_14: { label: '14-seater Matatu', seats: 14, desc: 'Standard Toyota HiAce / Nissan Urvan' },
    coaster_33: { label: '33-seater Coaster', seats: 33, desc: 'Toyota Coaster — large-capacity bus' },
    van_11: { label: '11-seater Van', seats: 11, desc: 'Small shuttle van' },
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Bus className="w-5 h-5 text-blue-600" />
            Bus Fleet Manager
            <Badge variant="outline" className="text-xs ml-1">{buses.length} buses</Badge>
          </CardTitle>
          <Button size="sm" onClick={() => setShowForm(s => !s)} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-1" />
            {showForm ? 'Cancel' : 'Add Bus'}
          </Button>
        </div>
        <CardDescription>
          Register a new bus — pick a layout (14, 33, or 11 seater), assign a route, and a fresh trip is auto-started. 33-seater coasters auto-generate the full 33-seat grid.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showForm && (
          <div className="border rounded-lg p-3 bg-blue-50/40 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Bus Name *</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Pipeline Coaster" />
              </div>
              <div>
                <Label className="text-xs">Registration Number *</Label>
                <Input value={reg} onChange={e => setReg(e.target.value)} placeholder="KEE 778M" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Layout</Label>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(layoutMeta) as Array<keyof typeof layoutMeta>).map(k => (
                  <button
                    key={k}
                    onClick={() => setLayout(k)}
                    className={`border rounded-lg p-2 text-left text-xs transition-all ${
                      layout === k ? 'border-blue-500 bg-blue-100' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <p className="font-semibold">{layoutMeta[k].label}</p>
                    <p className="text-gray-500 mt-0.5">{layoutMeta[k].seats} seats</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{layoutMeta[k].desc}</p>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Assign Route (optional)</Label>
              <select
                value={routeId}
                onChange={e => setRouteId(e.target.value)}
                className="w-full border rounded-md px-2 py-1.5 text-sm"
              >
                <option value="">— No route —</option>
                {routes.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.code ? `#${r.code}` : ''} {r.name} ({r.stops?.length || 0} stops)
                  </option>
                ))}
              </select>
            </div>
            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</div>
            )}
            <Button onClick={handleCreate} disabled={loading} className="bg-blue-600 hover:bg-blue-700">
              {loading ? 'Creating...' : `Add ${layoutMeta[layout].label}`}
            </Button>
          </div>
        )}

        {buses.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">No buses registered yet.</p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
            {buses.map(b => (
              <div key={b.id} className="border rounded-lg p-3 hover:bg-blue-50/30">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm">{b.name}</p>
                      <Badge variant="outline" className="text-[10px]">{b.registrationNumber}</Badge>
                      <Badge variant="default" className="bg-blue-100 text-blue-700 border-blue-300 text-[10px]">
                        {(layoutMeta as any)[b.layoutType]?.label || b.layoutType} • {b.totalSeats}p
                      </Badge>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Route: {b.route?.name || 'Unassigned'}</p>
                  </div>
                </div>
                <div className="mt-2">
                  <select
                    value={b.routeId || ''}
                    onChange={e => handleAssignRoute(b.id, e.target.value)}
                    className="w-full text-xs border rounded px-2 py-1"
                  >
                    <option value="">— Reassign Route —</option>
                    {routes.map(r => (
                      <option key={r.id} value={r.id}>
                        {r.code ? `#${r.code}` : ''} {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════════
// OWNER PANEL
// ═══════════════════════════════════════════════════════════════════
function OwnerPanel({
  busData,
  tripData,
  stops,
  seats,
  currentStopIndex,
  transactions,
  gpsData,
  fleetData,
  ownerId,
  onRefresh,
  onReset,
}: {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  transactions: Transaction[]
  gpsData: GPSData | null
  fleetData: any
  ownerId: string | null
  onRefresh: () => void
  onReset: () => void
}) {
  const [ownerData, setOwnerData] = useState<any>(null)
  const [leafletReady, setLeafletReady] = useState(false)

  // Load Leaflet CSS + fix icons on client side
  useEffect(() => {
    if (typeof window !== 'undefined' && !leafletReady) {
      // Add Leaflet CSS via link tag if not already present
      if (!document.querySelector('link[href*="leaflet"]')) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'
        document.head.appendChild(link)
      }
      // Fix default marker icons
      import('leaflet').then((L) => {
        delete (L.Icon.Default.prototype as any)._getIconUrl
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
          iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
          shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        })
        setLeafletReady(true)
      }).catch(() => {
        // Leaflet not available yet, retry
        setTimeout(() => setLeafletReady(false), 1000)
      })
    }
  }, [leafletReady])

  useEffect(() => {
    const fetchOwner = async () => {
      try {
        const qs = ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : ''
        const res = await fetch(`/api/owner${qs}`)
        const data = await res.json()
        setOwnerData(data)
      } catch (e) {
        console.error('Failed to fetch owner data', e)
      }
    }
    fetchOwner()
  }, [tripData, ownerId])

  const todayRevenue = tripData?.totalRevenue || 0
  const todayPassengers = tripData?.totalPassengers || 0
  const occupancyRate = seats.length > 0
    ? Math.round((seats.filter(s => s.isOccupied).length / seats.length) * 100)
    : 0

  // Revenue by method
  const revenueByMethod = ownerData?.analytics?.revenueByMethod || {}
  const methodChartData = Object.entries(revenueByMethod).map(([method, amount]) => ({
    name: method.toUpperCase(),
    value: amount as number,
    fill: PAYMENT_COLORS[method] || '#94a3b8',
  }))

  // Revenue by stop
  const revenueByStop: Record<string, number> = {}
  const passengers = tripData?.passengers || []
  passengers.forEach(p => {
    if (p.paymentStatus === 'paid') {
      revenueByStop[p.alightingStop] = (revenueByStop[p.alightingStop] || 0) + p.fare
    }
  })
  const stopChartData = Object.entries(revenueByStop).map(([stop, amount]) => ({
    name: stop.length > 15 ? stop.slice(0, 15) + '…' : stop,
    revenue: amount,
  }))

  // Payment breakdown for pie
  const paymentBreakdown = Object.entries(revenueByMethod).map(([method, amount]) => ({
    name: method.toUpperCase(),
    value: amount as number,
  }))

  // Trip event log
  const eventLog = passengers
    .flatMap(p => [
      {
        type: 'boarded' as const,
        name: p.name || 'Passenger',
        detail: `Seat ${p.seat?.number} → ${p.alightingStop}`,
        time: p.boardedAt,
        fare: p.fare,
        payment: p.paymentStatus,
      },
      ...(p.alightedAt ? [{
        type: 'alighted' as const,
        name: p.name || 'Passenger',
        detail: `Seat ${p.seat?.number}`,
        time: p.alightedAt!,
        fare: p.fare,
        payment: p.paymentStatus,
      }] : []),
    ])
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

  // Mini seat map
  const occupiedSet = new Set(seats.filter(s => s.isOccupied).map(s => s.number))

  // Routes from ownerData (used by BusManager for route assignment)
  const routes = ownerData?.routes || []

  return (
    <div className="space-y-6">
      {/* SACCO Identity Banner */}
      {ownerData?.sacco && (
        <Card className="bg-gradient-to-r from-blue-700 to-teal-700 text-white border-none">
          <CardContent className="p-4 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-lg">{ownerData.sacco.name}</p>
                <p className="text-xs text-blue-100">
                  {ownerData.sacco.code ? `Code: ${ownerData.sacco.code} • ` : ''}
                  Region: {ownerData.sacco.region} • Owner: {ownerData.owner.name}
                </p>
              </div>
            </div>
            <div className="flex gap-2 text-center">
              <div className="bg-white/15 px-3 py-1.5 rounded">
                <p className="text-lg font-bold leading-none">{ownerData.analytics?.totalBuses ?? 0}</p>
                <p className="text-[10px] text-blue-100">Buses</p>
              </div>
              <div className="bg-white/15 px-3 py-1.5 rounded">
                <p className="text-lg font-bold leading-none">{ownerData.analytics?.totalRoutes ?? 0}</p>
                <p className="text-[10px] text-blue-100">Routes</p>
              </div>
              <div className="bg-white/15 px-3 py-1.5 rounded">
                <p className="text-lg font-bold leading-none">{ownerData.analytics?.totalPassengersAllTime ?? 0}</p>
                <p className="text-[10px] text-blue-100">Passengers</p>
              </div>
              <div className="bg-white/15 px-3 py-1.5 rounded">
                <p className="text-lg font-bold leading-none">KES {(ownerData.analytics?.totalRevenueAllTime ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-blue-100">All-time Rev</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Fleet Overview Stats */}
      {fleetData?.stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
          <Card className="bg-gradient-to-br from-blue-500 to-blue-700 text-white">
            <CardContent className="p-3 text-center">
              <p className="text-xl font-bold">{fleetData.stats.totalBuses}</p>
              <p className="text-[10px] text-blue-100">Total Buses</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-teal-500 to-teal-700 text-white">
            <CardContent className="p-3 text-center">
              <p className="text-xl font-bold">{fleetData.stats.tracking}</p>
              <p className="text-[10px] text-teal-100">Tracking</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-cyan-500 to-cyan-700 text-white">
            <CardContent className="p-3 text-center">
              <p className="text-xl font-bold">{fleetData.stats.moving}</p>
              <p className="text-[10px] text-cyan-100">Moving</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-amber-500 to-amber-700 text-white">
            <CardContent className="p-3 text-center">
              <p className="text-xl font-bold">{fleetData.stats.idle}</p>
              <p className="text-[10px] text-amber-100">Idle</p>
            </CardContent>
          </Card>
          <Card className={`bg-gradient-to-br ${fleetData.stats.offRoute > 0 ? 'from-red-500 to-red-700' : 'from-gray-500 to-gray-700'} text-white`}>
            <CardContent className="p-3 text-center">
              <p className="text-xl font-bold">{fleetData.stats.offRoute}</p>
              <p className="text-[10px] text-white/80">Off Route</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-violet-500 to-violet-700 text-white">
            <CardContent className="p-3 text-center">
              <p className="text-xl font-bold">{fleetData.stats.totalPassengers}</p>
              <p className="text-[10px] text-violet-100">Passengers</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Fleet Bus List */}
      {fleetData?.fleet?.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Bus className="w-5 h-5 text-blue-600" />
                Fleet Status
              </CardTitle>
              <Badge variant="outline" className="text-xs">
                {fleetData.fleet.filter((b: any) => b.isTracking).length} of {fleetData.fleet.length} live
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
              {fleetData.fleet.map((bus: any) => (
                <div
                  key={bus.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${
                    bus.isOffRoute ? 'border-red-300 bg-red-50' :
                    bus.isTracking ? 'border-blue-200 bg-blue-50/40' :
                    'border-gray-200 bg-gray-50'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    bus.isOffRoute ? 'bg-red-100' :
                    bus.speed > 0 ? 'bg-blue-100' : 'bg-gray-200'
                  }`}>
                    <Bus className={`w-5 h-5 ${bus.isOffRoute ? 'text-red-600' : bus.speed > 0 ? 'text-blue-600' : 'text-gray-500'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm">{bus.registrationNumber}</p>
                      <Badge variant="outline" className="text-[10px]">{bus.name}</Badge>
                      {bus.isTracking && (
                        <Badge className="text-[10px] bg-blue-100 text-blue-700 border-blue-300">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse mr-1" />
                          LIVE
                        </Badge>
                      )}
                      {bus.isOffRoute && (
                        <Badge variant="destructive" className="text-[10px]">OFF ROUTE</Badge>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {bus.routeName || 'No route assigned'} • {bus.saccoName}
                    </p>
                    {bus.intelligence && (
                      <p className="text-xs text-blue-600 mt-0.5">
                        {bus.intelligence.atStopName
                          ? `📍 At ${bus.intelligence.atStopName}`
                          : bus.intelligence.etaToNextStop
                          ? `→ ETA next stop: ${bus.intelligence.etaToNextStop} min`
                          : 'En route'}
                        {bus.intelligence.offRouteDistance > 0 && bus.isOffRoute && (
                          <span className="text-red-600 ml-2">({bus.intelligence.offRouteDistance}m off)</span>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-blue-700">{bus.speed || 0}</p>
                    <p className="text-[10px] text-gray-400">km/h</p>
                    {bus.totalRevenue > 0 && (
                      <p className="text-xs text-blue-600 mt-1">KES {bus.totalRevenue}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* GPS Intelligence Bar */}
      {gpsData && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card className="bg-blue-50/50 border-blue-200">
            <CardContent className="p-3">
              <p className="text-[10px] text-blue-600 uppercase tracking-wide">Route Progress</p>
              <p className="text-lg font-bold text-blue-800">{gpsData.routeProgressPercent ?? 0}%</p>
              <Progress value={gpsData.routeProgressPercent ?? 0} className="h-1.5 mt-1" />
            </CardContent>
          </Card>
          <Card className={`border ${gpsData.isOffRoute ? 'bg-red-50 border-red-300' : 'bg-blue-50/50 border-blue-200'}`}>
            <CardContent className="p-3">
              <p className="text-[10px] text-blue-600 uppercase tracking-wide">Off-Route Status</p>
              <p className={`text-lg font-bold ${gpsData.isOffRoute ? 'text-red-700' : 'text-blue-700'}`}>
                {gpsData.isOffRoute ? `${gpsData.offRouteDistance || 0}m` : 'On Route'}
              </p>
              <p className="text-[10px] text-gray-500">
                Threshold: {gpsData.offRouteThreshold || 200}m
              </p>
            </CardContent>
          </Card>
          <Card className="bg-blue-50/50 border-blue-200">
            <CardContent className="p-3">
              <p className="text-[10px] text-blue-600 uppercase tracking-wide">Geofence</p>
              <p className="text-lg font-bold text-blue-800">
                {gpsData.atStopName ? gpsData.atStopName.split(' ')[0] : 'En route'}
              </p>
              <p className="text-[10px] text-gray-500">
                {gpsData.atStopIndex !== undefined && gpsData.atStopIndex >= 0
                  ? `Stop #${gpsData.atStopIndex + 1}`
                  : 'No stop nearby'}
              </p>
            </CardContent>
          </Card>
          <Card className="bg-blue-50/50 border-blue-200">
            <CardContent className="p-3">
              <p className="text-[10px] text-blue-600 uppercase tracking-wide">Next Stop ETA</p>
              <p className="text-lg font-bold text-blue-800">
                {gpsData.etas?.find(e => e.order === (currentStopIndex + 2))?.etaMinutes ?? '—'}
                <span className="text-xs font-normal ml-1">min</span>
              </p>
              <p className="text-[10px] text-gray-500 truncate">
                {stops[currentStopIndex + 1]?.name || 'Final stop'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ETA Table */}
      {gpsData?.etas && gpsData.etas.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Navigation className="w-5 h-5 text-blue-600" />
              ETA to All Stops
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar">
              {gpsData.etas.map(eta => {
                const isPast = eta.order < currentStopIndex + 1
                const isCurrent = eta.order === currentStopIndex + 1
                return (
                  <div
                    key={eta.order}
                    className={`flex items-center gap-3 p-2 rounded text-sm ${
                      isCurrent ? 'bg-blue-100 border border-blue-300' :
                      isPast ? 'opacity-40' : ''
                    }`}
                  >
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      isPast ? 'bg-blue-500 text-white' :
                      isCurrent ? 'bg-blue-600 text-white animate-pulse' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {eta.order}
                    </div>
                    <span className={`flex-1 truncate ${isCurrent ? 'font-bold' : ''}`}>
                      {eta.stopName}
                    </span>
                    <span className="text-xs text-gray-500 shrink-0">{eta.distanceMeters}m</span>
                    <span className={`text-sm font-semibold shrink-0 w-16 text-right ${
                      eta.etaMinutes === null ? 'text-gray-300' : 'text-blue-700'
                    }`}>
                      {eta.etaMinutes === null ? '—' : `${eta.etaMinutes}m`}
                    </span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Route & Bus Manager ──────────────────────────────────── */}
      {/* Multi-SACCO core: each SACCO can register their own numbered
          Nairobi-style routes and add buses (14, 33, or 11 seater). */}
      <Tabs defaultValue="routes" className="w-full">
        <TabsList className="grid grid-cols-2 w-full">
          <TabsTrigger value="routes" className="flex items-center gap-1.5">
            <RouteIcon className="w-4 h-4" /> Routes
          </TabsTrigger>
          <TabsTrigger value="buses" className="flex items-center gap-1.5">
            <Bus className="w-4 h-4" /> Buses
          </TabsTrigger>
        </TabsList>
        <TabsContent value="routes" className="mt-3">
          <RouteManager ownerId={ownerId} onRoutesChanged={onRefresh} />
        </TabsContent>
        <TabsContent value="buses" className="mt-3">
          <BusManager ownerId={ownerId} routes={routes} onBusesChanged={onRefresh} />
        </TabsContent>
      </Tabs>

      {/* ─── Multi-Bus Fleet Map ──────────────────────────────────── */}
      {/* Shows ALL buses in the SACCO on one map, each with their own
          route polyline + stop markers + live position marker. */}
      {typeof window !== 'undefined' && leafletReady && fleetData?.fleet?.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <MapPin className="w-5 h-5 text-blue-600" />
                Live Fleet Map
                <Badge variant="default" className="bg-blue-100 text-blue-700 border-blue-300 ml-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse mr-1" />
                  {fleetData.stats?.tracking ?? 0} of {fleetData.stats?.totalBuses ?? 0} live
                </Badge>
              </CardTitle>
              <div className="text-xs text-gray-500">
                {ownerData?.sacco?.name} • {fleetData.fleet.length} buses
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div style={{ height: '420px', borderRadius: '8px', overflow: 'hidden' }}>
              <MapContainer
                center={fleetData.fleet[0]?.position
                  ? [fleetData.fleet[0].position.lat, fleetData.fleet[0].position.lng]
                  : (ownerData?.sacco?.region === 'Nairobi' ? [-1.2864, 36.8172] : [-4.05, 39.67])}
                zoom={12}
                style={{ height: '100%', width: '100%' }}
                scrollWheelZoom={false}
              >
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />

                {/* Render each bus with its own route line + stops + position */}
                {fleetData.fleet.map((bus: any, idx: number) => {
                  // Different color per bus
                  const colors = ['#10b981', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4']
                  const color = colors[idx % colors.length]
                  return (
                    <React.Fragment key={bus.id}>
                      {/* This bus's route line */}
                      {bus.routeLine?.length > 0 && (
                        <Polyline
                          positions={bus.routeLine.map((p: any) => [p.lat, p.lng])}
                          pathOptions={{ color, weight: 3, opacity: 0.4 }}
                        />
                      )}
                      {/* This bus's route stops */}
                      {bus.routeStops?.map((stop: any) => (
                        <Marker key={`${bus.id}-stop-${stop.order}`} position={[stop.lat, stop.lng]}>
                          <Popup>
                            <strong>{stop.stopName}</strong><br />
                            Stop #{stop.order} • {bus.registrationNumber}
                          </Popup>
                        </Marker>
                      ))}
                      {/* Live bus marker */}
                      {bus.position && (
                        <Marker position={[bus.position.lat, bus.position.lng]}>
                          <Popup>
                            <strong>🚌 {bus.name}</strong><br />
                            Reg: {bus.registrationNumber}<br />
                            {bus.routeCode ? `Route #${bus.routeCode} • ` : ''}{bus.routeName || 'No route'}<br />
                            Speed: {bus.speed || 0} km/h<br />
                            {bus.isOffRoute && <span style={{ color: 'red' }}>⚠️ Off route!</span>}
                            <br />
                            Updated: {bus.lastGpsAt ? new Date(bus.lastGpsAt).toLocaleTimeString() : 'N/A'}
                          </Popup>
                        </Marker>
                      )}
                    </React.Fragment>
                  )
                })}
              </MapContainer>
            </div>

            {/* Fleet legend */}
            <div className="flex flex-wrap gap-3 mt-3 text-xs">
              {fleetData.fleet.map((bus: any, idx: number) => {
                const colors = ['#10b981', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4']
                const color = colors[idx % colors.length]
                return (
                  <div key={bus.id} className="flex items-center gap-1.5 bg-gray-50 px-2 py-1 rounded border">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                    <span className="font-medium">{bus.registrationNumber}</span>
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-500">{bus.speed || 0} km/h</span>
                    {bus.isOffRoute && <Badge variant="destructive" className="text-[9px] h-4 px-1">OFF</Badge>}
                    {bus.isTracking && (
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" title="Live tracking" />
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Single-Bus Live Bus Tracking (focus on the selected bus) ── */}
      {typeof window !== 'undefined' && leafletReady && busData && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <Navigation className="w-5 h-5 text-blue-600" />
                Selected Bus: {busData.registrationNumber}
                <Badge variant="default" className="bg-blue-100 text-blue-700 border-blue-300 ml-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse mr-1" />
                  {gpsData?.speed ? 'Moving' : 'Idle'}
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>Bus: <strong className="text-blue-700">{busData.registrationNumber}</strong></span>
                <span>Route: <strong className="text-blue-700">{busData.route?.name || 'No route'}</strong></span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div style={{ height: '340px', borderRadius: '8px', overflow: 'hidden' }}>
              <MapContainer
                center={gpsData?.currentLocation ? [gpsData.currentLocation.lat, gpsData.currentLocation.lng] : [-4.05, 39.67]}
                zoom={13}
                style={{ height: '100%', width: '100%' }}
                scrollWheelZoom={false}
              >
                <MapRecenter position={gpsData?.currentLocation ? [gpsData.currentLocation.lat, gpsData.currentLocation.lng] : null} />
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
                {/* Full route line */}
                <Polyline positions={gpsData?.routeLine?.map(p => [p.lat, p.lng]) || []} color="#10b981" weight={4} opacity={0.5} />
                {/* Recent trail (last 20 points) */}
                {gpsData?.gpsHistory && gpsData.gpsHistory.length > 1 && (
                  <Polyline
                    positions={gpsData.gpsHistory.map(p => [p.lat, p.lng])}
                    pathOptions={{ color: '#059669', weight: 3, dashArray: '6,4' }}
                  />
                )}
                {/* All route stops */}
                {gpsData?.routeStops?.map(stop => (
                  <Marker key={stop.order} position={[stop.lat, stop.lng]}>
                    <Popup>
                      <strong>{stop.stopName}</strong><br />
                      Stop #{stop.order}
                    </Popup>
                  </Marker>
                ))}
                {/* Live bus marker */}
                {gpsData?.currentLocation && (
                  <Marker position={[gpsData.currentLocation.lat, gpsData.currentLocation.lng]}>
                    <Popup>
                      <strong>🚌 {busData?.name || 'MatatuLink Bus'}</strong><br />
                      Reg: {busData?.registrationNumber}<br />
                      Speed: {gpsData.speed} km/h<br />
                      Heading: {gpsData.heading}°<br />
                      Updated: {new Date(gpsData.lastUpdated).toLocaleTimeString()}
                    </Popup>
                  </Marker>
                )}
              </MapContainer>
            </div>

            {/* Telemetry strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
              <div className="bg-blue-50 rounded-lg p-2 text-center border border-blue-200">
                <p className="text-[10px] text-blue-600 uppercase tracking-wide">Speed</p>
                <p className="font-bold text-blue-800 text-sm">{gpsData?.speed || 0} <span className="text-[10px] font-normal">km/h</span></p>
              </div>
              <div className="bg-blue-50 rounded-lg p-2 text-center border border-blue-200">
                <p className="text-[10px] text-blue-600 uppercase tracking-wide">Heading</p>
                <p className="font-bold text-blue-800 text-sm">{gpsData?.heading || 0}°</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-2 text-center border border-blue-200">
                <p className="text-[10px] text-blue-600 uppercase tracking-wide">Last Ping</p>
                <p className="font-bold text-blue-800 text-sm">
                  {gpsData?.lastUpdated ? new Date(gpsData.lastUpdated).toLocaleTimeString() : 'N/A'}
                </p>
              </div>
              <div className="bg-blue-50 rounded-lg p-2 text-center border border-blue-200">
                <p className="text-[10px] text-blue-600 uppercase tracking-wide">Trail Points</p>
                <p className="font-bold text-blue-800 text-sm">{gpsData?.historyCount || 0}</p>
              </div>
            </div>

            {/* Coordinates row */}
            {gpsData?.currentLocation && (
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-500 justify-center">
                <span>Lat: <strong>{gpsData.currentLocation.lat.toFixed(5)}</strong></span>
                <span>Lng: <strong>{gpsData.currentLocation.lng.toFixed(5)}</strong></span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Revenue Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Card className="bg-gradient-to-br from-blue-500 to-blue-700 text-white">
          <CardContent className="p-4">
            <DollarSign className="w-6 h-6 mb-1 opacity-80" />
            <p className="text-2xl font-bold">KES {todayRevenue.toLocaleString()}</p>
            <p className="text-blue-200 text-sm">Today&apos;s Revenue</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-teal-500 to-teal-700 text-white">
          <CardContent className="p-4">
            <Users className="w-6 h-6 mb-1 opacity-80" />
            <p className="text-2xl font-bold">{todayPassengers}</p>
            <p className="text-teal-200 text-sm">Total Passengers</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-500 to-amber-700 text-white col-span-2 sm:col-span-1">
          <CardContent className="p-4">
            <TrendingUp className="w-6 h-6 mb-1 opacity-80" />
            <p className="text-2xl font-bold">{occupancyRate}%</p>
            <p className="text-amber-200 text-sm">Occupancy Rate</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by Payment Method - Bar Chart */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-blue-600" />
              Revenue by Method
            </CardTitle>
          </CardHeader>
          <CardContent>
            {methodChartData.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={methodChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <RechartsTooltip formatter={(value: number) => `KES ${value}`} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {methodChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Payment Breakdown - Pie Chart */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <PieChartIcon className="w-5 h-5 text-blue-600" />
              Payment Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {paymentBreakdown.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={paymentBreakdown}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {paymentBreakdown.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={PAYMENT_COLORS[entry.name.toLowerCase()] || '#94a3b8'}
                      />
                    ))}
                  </Pie>
                  <RechartsTooltip formatter={(value: number) => `KES ${value}`} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Seat Occupancy + Stop Revenue */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Mini Seat Map */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Armchair className="w-5 h-5 text-blue-600" />
              Seat Occupancy
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Layout-aware mini seat map (uses row/col for 33-seater) */}
            {(() => {
              const hasLayout = seats.length > 0 && seats.every(s => s.row !== undefined && s.col !== undefined)
              if (hasLayout) {
                const maxRow = Math.max(...seats.map(s => s.row as number))
                const maxCol = Math.max(...seats.map(s => s.col as number))
                const seatsByRowCol = new Map<string, Seat>()
                seats.forEach(s => seatsByRowCol.set(`${s.row}-${s.col}`, s))
                return (
                  <div className="overflow-x-auto">
                    <div
                      className="grid gap-1 mx-auto"
                      style={{
                        gridTemplateColumns: `repeat(${maxCol}, minmax(20px, 28px))`,
                        gridTemplateRows: `repeat(${maxRow}, minmax(22px, 28px))`,
                        width: 'fit-content',
                      }}
                    >
                      {Array.from({ length: maxRow }).map((_, rIdx) =>
                        Array.from({ length: maxCol }).map((__, cIdx) => {
                          const seat = seatsByRowCol.get(`${rIdx + 1}-${cIdx + 1}`)
                          if (!seat) return <div key={`${rIdx}-${cIdx}`} />
                          const p = seat.passenger
                          let bgColor = 'bg-blue-100 border-blue-300'
                          if (seat.isOccupied && p) {
                            if (p.paymentStatus === 'unpaid' || p.paymentStatus === 'pending') {
                              bgColor = 'bg-yellow-100 border-yellow-400'
                            } else if (p.alightingStopOrder <= currentStopIndex + 2) {
                              bgColor = 'bg-red-100 border-red-400'
                            } else {
                              bgColor = 'bg-orange-100 border-orange-400'
                            }
                          }
                          return (
                            <div
                              key={seat.id}
                              className={`p-0.5 rounded border text-center text-[10px] leading-tight ${bgColor}`}
                              title={`Seat ${seat.number}${p ? ` · ${p.name || 'Passenger'}` : ' · Free'}`}
                            >
                              {seat.number}
                            </div>
                          )
                        })
                      )}
                    </div>
                    <p className="text-[10px] text-gray-400 text-center mt-2">
                      {seats.length} seats · {busData?.layoutType?.replace('_', ' ') || 'matatu 14'}
                    </p>
                  </div>
                )
              }
              return (
                <div className="grid grid-cols-7 gap-1.5">
                  {seats.map(seat => {
                    const isOccupied = occupiedSet.has(seat.number)
                    const p = seat.passenger
                    let bgColor = 'bg-blue-100 border-blue-300'
                    if (isOccupied && p) {
                      if (p.paymentStatus === 'unpaid' || p.paymentStatus === 'pending') {
                        bgColor = 'bg-yellow-100 border-yellow-400'
                      } else if (p.alightingStopOrder <= currentStopIndex + 2) {
                        bgColor = 'bg-red-100 border-red-400'
                      } else {
                        bgColor = 'bg-orange-100 border-orange-400'
                      }
                    }
                    return (
                      <div
                        key={seat.id}
                        className={`p-1 rounded border text-center text-xs ${bgColor}`}
                      >
                        {seat.number}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            <div className="flex gap-3 mt-3 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-100 border border-blue-300" /> Free</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 border border-red-400" /> Alighting</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-100 border border-orange-400" /> Far</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-100 border border-yellow-400" /> Unpaid</span>
            </div>
          </CardContent>
        </Card>

        {/* Stop Revenue */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <MapPin className="w-5 h-5 text-blue-600" />
              Revenue by Stop
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stopChartData.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={stopChartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                  <RechartsTooltip formatter={(value: number) => `KES ${value}`} />
                  <Bar dataKey="revenue" fill="#10b981" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Active Trip Info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Bus className="w-5 h-5 text-blue-600" />
            Active Trip Info
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Current Stop</p>
              <p className="font-semibold">{stops[currentStopIndex]?.name || '—'}</p>
            </div>
            <div>
              <p className="text-gray-500">On Board</p>
              <p className="font-semibold">{passengers.filter(p => !p.alightedAt).length}</p>
            </div>
            <div>
              <p className="text-gray-500">Total Fare Collected</p>
              <p className="font-semibold text-blue-600">KES {todayRevenue.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-gray-500">Trip Status</p>
              <Badge variant="default">{tripData?.status || 'active'}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Trip Event Log */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-600" />
            Trip Event Log
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
            {eventLog.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No events yet</p>
            ) : (
              eventLog.map((event, i) => (
                <div key={i} className="flex items-start gap-3 p-2 rounded bg-gray-50 text-sm">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    event.type === 'boarded' ? 'bg-blue-100' : 'bg-blue-100'
                  }`}>
                    {event.type === 'boarded' ? (
                      <User className="w-4 h-4 text-blue-600" />
                    ) : (
                      <ArrowRight className="w-4 h-4 text-blue-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{event.name} {event.type}</p>
                    <p className="text-gray-500 text-xs">{event.detail}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-gray-400">
                      {new Date(event.time).toLocaleTimeString()}
                    </p>
                    <Badge
                      variant={event.payment === 'paid' ? 'default' : 'destructive'}
                      className="text-[10px]"
                    >
                      KES {event.fare} • {event.payment}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
