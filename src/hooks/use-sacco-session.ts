'use client'

/**
 * useSaccoSession — shared state hook for crew + admin pages.
 *
 * Encapsulates everything that the old single-page app did:
 *   - NextAuth session hydration (sign-in / sign-out)
 *   - SACCO bus list + selected bus state
 *   - Bus / Trip / GPS / Fleet data fetching
 *   - WebSocket lifecycle + bus-room join
 *   - Derived `stops`, `seats`, `currentStopIndex`, `passengersOnBoard`
 *
 * Returns null for `authState` while the session is still being
 * resolved — callers should render a loading spinner in that window.
 * Once resolved, `authState` is either:
 *   - `{ authenticated: false, demoOwners }` — caller renders the
 *     sign-in card.
 *   - `{ authenticated: true, ownerId, ownerMeta }` — caller renders
 *     the panel(s).
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { signIn, signOut, useSession } from 'next-auth/react'

import type {
  BusData, GPSData, Stop, Seat, TripData, Transaction, WSNotification,
} from '@/lib/types'

export interface SaccoOwnerLite {
  email: string
  name: string
  saccoName: string
  region: string
}

export interface OwnerMeta {
  saccoName: string
  region: string
}

export interface BusListItem {
  id: string
  name: string
  registrationNumber: string
  totalSeats: number
  layoutType?: string
  routeName?: string | null
  routeCode?: string | null
}

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated'; demoOwners: SaccoOwnerLite[] }
  | { status: 'authenticated'; ownerId: string; ownerMeta: OwnerMeta; demoOwners: SaccoOwnerLite[] }

export interface SaccoSessionState {
  auth: AuthState
  busData: BusData | null
  tripData: TripData | null
  transactions: Transaction[]
  notifications: WSNotification[]
  gpsData: GPSData | null
  fleetData: any
  busList: BusListItem[]
  selectedBusId: string | null
  setSelectedBusId: (id: string | null) => void
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  passengersOnBoard: any[]
  emitSocket: (event: string, data: any) => void
  refreshBusData: () => Promise<void>
  refreshTripData: () => Promise<void>
  refreshGpsData: () => Promise<void>
  refreshFleetData: () => Promise<void>
  handleReset: () => Promise<void>
  // Sign-in helpers (used by the SignInCard)
  signInEmail: string
  signInPassword: string
  setSignInEmail: (v: string) => void
  setSignInPassword: (v: string) => void
  signInLoading: boolean
  handleSignIn: (e: React.FormEvent) => Promise<void>
  handleSignOut: () => Promise<void>
  // Demo accounts (for sign-in card)
  demoOwners: SaccoOwnerLite[]
}

export function useSaccoSession(): SaccoSessionState {
  const { data: session, status } = useSession()
  const sessionOwnerId = (session as any)?.ownerId as string | undefined

  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [demoOwners, setDemoOwners] = useState<SaccoOwnerLite[]>([])
  const [ownerId, setOwnerId] = useState<string | null>(sessionOwnerId ?? null)
  const [ownerMeta, setOwnerMeta] = useState<OwnerMeta | null>(null)

  const [busData, setBusData] = useState<BusData | null>(null)
  const [tripData, setTripData] = useState<TripData | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [notifications, setNotifications] = useState<WSNotification[]>([])
  const [gpsData, setGpsData] = useState<GPSData | null>(null)
  const [fleetData, setFleetData] = useState<any>(null)

  const [busList, setBusList] = useState<BusListItem[]>([])
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null)

  const [signInEmail, setSignInEmail] = useState('')
  const [signInPassword, setSignInPassword] = useState('')
  const [signInLoading, setSignInLoading] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const busDataRef = useRef<BusData | null>(null)
  const activeTabRef = useRef<string>('crew')
  const fetchFleetDataRef = useRef<(() => Promise<void>) | null>(null)

  // ─── Fleet data fetching (for Admin panel) ────────────────────
  const refreshFleetData = useCallback(async () => {
    try {
      const qs = ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : ''
      const res = await fetch(`/api/fleet${qs}`)
      const data = await res.json()
      setFleetData(data)
    } catch (e) {
      console.error('Failed to fetch fleet data', e)
    }
  }, [ownerId])

  useEffect(() => { fetchFleetDataRef.current = refreshFleetData }, [refreshFleetData])
  useEffect(() => { busDataRef.current = busData }, [busData])

  // ─── Data fetching ────────────────────────────────────────────
  const refreshBusData = useCallback(async () => {
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

  const refreshTripData = useCallback(async () => {
    try {
      const res = await fetch('/api/trip')
      const data = await res.json()
      if (data.trip) setTripData(data.trip)
    } catch (e) {
      console.error('Failed to fetch trip data', e)
    }
  }, [])

  const refreshGpsData = useCallback(async () => {
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

  const emitSocket = useCallback((event: string, data: any) => {
    socketRef.current?.emit(event, data)
  }, [])

  // ─── Initial load: /api/me ────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/me')
        const data = await res.json()
        if (data.demoOwners?.length) setDemoOwners(data.demoOwners)
        if (data.authenticated && data.owner?.id) {
          setOwnerId(data.owner.id)
          setOwnerMeta({ saccoName: data.sacco.name, region: data.sacco.region })
          setAuth({
            status: 'authenticated',
            ownerId: data.owner.id,
            ownerMeta: { saccoName: data.sacco.name, region: data.sacco.region },
            demoOwners: data.demoOwners ?? [],
          })
        } else {
          setOwnerId(null)
          setAuth({ status: 'unauthenticated', demoOwners: data.demoOwners ?? [] })
        }
      } catch (e) {
        console.error('Failed to fetch /api/me', e)
        setAuth({ status: 'unauthenticated', demoOwners: [] })
      }
    }
    load()
  }, [])

  // Whenever NextAuth session changes (login / logout), re-sync.
  useEffect(() => {
    if (sessionOwnerId) {
      setOwnerId(sessionOwnerId)
    } else if (status === 'unauthenticated' && auth.status === 'authenticated') {
      setOwnerId(null)
      setBusData(null)
      setTripData(null)
      setFleetData(null)
      setAuth({ status: 'unauthenticated', demoOwners })
    }
  }, [sessionOwnerId, status])

  // ─── Sign-in handler ──────────────────────────────────────────
  const handleSignIn = useCallback(async (e: React.FormEvent) => {
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
        setTimeout(() => window.location.reload(), 400)
      }
    } catch {
      toast.error('Sign-in failed')
    } finally {
      setSignInLoading(false)
    }
  }, [signInEmail, signInPassword])

  const handleSignOut = useCallback(async () => {
    await signOut({ redirect: false })
    setOwnerId(null)
    setBusData(null)
    setTripData(null)
    setFleetData(null)
    setAuth({ status: 'unauthenticated', demoOwners })
    toast.info('Signed out')
  }, [demoOwners])

  // ─── Reset demo data ──────────────────────────────────────────
  const handleReset = useCallback(async () => {
    try {
      await fetch('/api/seed', { method: 'POST' })
      toast.success('Database reset!', { description: 'Demo data re-seeded.' })
      await refreshBusData()
    } catch {
      toast.error('Failed to reset database')
    }
  }, [refreshBusData])

  // ─── Load bus list when ownerId changes ───────────────────────
  useEffect(() => {
    if (!ownerId) return
    const loadSacco = async () => {
      try {
        const res = await fetch(`/api/buses?ownerId=${encodeURIComponent(ownerId)}`)
        const data = await res.json()
        if (data.buses) {
          const simplified: BusListItem[] = data.buses.map((b: any) => ({
            id: b.id,
            name: b.name,
            registrationNumber: b.registrationNumber,
            totalSeats: b.totalSeats,
            layoutType: b.layoutType,
            routeName: b.route?.name ?? null,
            routeCode: b.route?.code ?? null,
          }))
          setBusList(simplified)
          if (!selectedBusId || !simplified.find((b: BusListItem) => b.id === selectedBusId)) {
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

  // When selectedBusId changes, refetch bus/trip/gps data + rejoin WS room
  useEffect(() => {
    if (selectedBusId) {
      refreshBusData().then(() => refreshGpsData())
      if (socketRef.current?.connected) {
        socketRef.current.emit('join_bus', selectedBusId)
      }
    }
  }, [selectedBusId, ownerId])

  // ─── WebSocket lifecycle ──────────────────────────────────────
  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    socket.on('connect', () => { console.log('[WS] Connected') })

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
      refreshBusData()
    })

    socket.on('passenger_alighted', (data: any) => {
      toast.info(`👋 Seat ${data.seatNumber} is now free`, { description: 'Passenger alighted' })
      refreshBusData()
      refreshTripData()
    })

    socket.on('payment_update', () => { refreshBusData(); refreshTripData() })
    socket.on('advance_stop', () => { refreshBusData(); refreshTripData() })

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
      if (activeTabRef.current === 'admin') {
        fetchFleetDataRef.current?.()
      }
    })

    socket.on('geofence_event', (data: { type: string; stopIndex: number; stopName?: string; timestamp: string }) => {
      if (data.type === 'stop_arrival' && data.stopName) {
        toast.success(`📍 Arrived at ${data.stopName}`, { description: 'Geofence auto-detected' })
      }
    })

    socket.on('off_route_alert', (data: { distance?: number; cleared?: boolean; timestamp: string }) => {
      if (data.cleared) {
        toast.success('✅ Back on route')
      } else if (data.distance) {
        toast.error(`⚠️ Off route — ${Math.round(data.distance)}m from route!`, {
          description: 'Owner has been notified',
        })
      }
    })

    return () => { socket.disconnect() }
  }, [refreshBusData, refreshTripData])

  // Re-join bus room when busData loads
  useEffect(() => {
    if (busData?.id && socketRef.current?.connected) {
      socketRef.current.emit('join_bus', busData.id)
    }
  }, [busData?.id])

  // ─── Derived data ─────────────────────────────────────────────
  const stops: Stop[] = busData?.route?.stops || []
  const seats: Seat[] = busData?.seats || []
  const currentStopIndex = tripData?.currentStopIndex || 0
  const passengersOnBoard = tripData?.passengers?.filter((p: any) => !p.alightedAt) || []

  return {
    auth,
    busData,
    tripData,
    transactions,
    notifications,
    gpsData,
    fleetData,
    busList,
    selectedBusId,
    setSelectedBusId,
    stops,
    seats,
    currentStopIndex,
    passengersOnBoard,
    emitSocket,
    refreshBusData,
    refreshTripData,
    refreshGpsData,
    refreshFleetData,
    handleReset,
    signInEmail,
    signInPassword,
    setSignInEmail,
    setSignInPassword,
    signInLoading,
    handleSignIn,
    handleSignOut,
    demoOwners,
  }
}
