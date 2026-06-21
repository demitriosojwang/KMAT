'use client'

/**
 * MatatuLink — router shell.
 *
 * This file used to contain all four panels (4224 LOC). After the
 * ponytail-audit split (Phase 7), it is just the router shell:
 *   - NextAuth session hydration
 *   - Sign-in screen (when unauthenticated)
 *   - Tab switcher (Passenger / Conductor / Driver / Owner)
 *   - WebSocket lifecycle + bus-room join
 *   - Bus / Trip / GPS / Fleet data fetching
 *   - Forwards shared state into the four panel components
 *
 * The panels themselves live in:
 *   src/components/passenger-panel.tsx
 *   src/components/conductor-panel.tsx
 *   src/components/driver-panel.tsx
 *   src/components/owner-panel.tsx   (also contains RouteManager + BusManager)
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { signIn, signOut, useSession } from 'next-auth/react'
import {
  Bus, Users, UserCheck, Car, BarChart3,
  RotateCcw, LogIn, Mail, Lock,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { PassengerPanel } from '@/components/passenger-panel'
import { ConductorPanel } from '@/components/conductor-panel'
import { DriverPanel } from '@/components/driver-panel'
import { OwnerPanel } from '@/components/owner-panel'
import type {
  BusData, GPSData, Stop, Seat, TripData, Transaction, WSNotification,
} from '@/lib/types'

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
  const stops: Stop[] = busData?.route?.stops || []
  const seats: Seat[] = busData?.seats || []
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
        <div
          className="text-center animate-in fade-in zoom-in-95 duration-200"
        >
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-700 flex items-center justify-center animate-pulse">
            <Bus className="w-8 h-8 text-yellow-300" />
          </div>
          <h2 className="text-xl font-bold text-blue-900">MatatuLink</h2>
          <p className="text-blue-600 text-sm mt-1">Loading…</p>
        </div>
      </div>
    )
  }

  // ─── Sign-in screen (unauthenticated) ────────────────────────
  if (!ownerId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-blue-800 to-blue-950 p-4">
        <div
          className="w-full max-w-md animate-in fade-in slide-in-from-bottom-5 duration-300"
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
        </div>
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
              {ownerMeta && (
                <p className="text-[10px] text-blue-200 leading-tight">
                  {ownerMeta.saccoName} · {ownerMeta.region}
                </p>
              )}
            </div>
          </div>

          {/* Active bus selector */}
          {busList.length > 0 && (
            <select
              value={selectedBusId ?? ''}
              onChange={e => setSelectedBusId(e.target.value || null)}
              className="bg-blue-900/60 text-white border border-blue-400 rounded-md px-2 py-1 text-xs"
            >
              {busList.map(b => (
                <option key={b.id} value={b.id} className="text-black">
                  {b.registrationNumber} · {b.routeCode ? `#${b.routeCode}` : b.routeName || 'No route'}
                </option>
              ))}
            </select>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={handleSignOut}
            className="border-blue-400 text-blue-100 hover:bg-blue-700 hover:text-white"
          >
            Sign out
          </Button>
        </div>

        {/* Tab bar */}
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-1 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-md text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === tab.key
                  ? 'bg-white text-blue-800 shadow-sm'
                  : 'text-blue-100 hover:text-white hover:bg-blue-700/50'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* ─── Content ────────────────────────────────────────────── */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <div
          key={activeTab}
          className="animate-in fade-in slide-in-from-bottom-3 duration-200"
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
        </div>
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
