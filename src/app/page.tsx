'use client'

/**
 * MatatuLink landing page — PASSENGER-FIRST.
 *
 * Public (no auth). The flow is:
 *   1. Hero: "Find your matatu" — explains the value prop.
 *   2. SACCO picker — pulled from /api/public/saccos. Clicking a
 *      SACCO expands its live buses.
 *   3. Each bus card shows: route, registration, live GPS dot,
 *      seat availability, and a "Board this matatu" button that
 *      deep-links to /passenger?bus=<id>.
 *   4. Three role cards at the bottom: Passenger (active), Crew,
 *      Admin — so SACCO staff know where to sign in.
 *
 * The passenger does NOT need an account to board — they just need
 * to know which SACCO operates their route. This mirrors how Kenyan
 * matatus actually work: riders wave down a bus by livery, not by
 * logging in.
 */
import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Bus, MapPin, Users, Wifi, WifiOff, Navigation,
  UserCheck, BarChart3, ArrowRight, Search, ShieldCheck,
  CreditCard, CloudOff, Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

interface PublicSacco {
  id: string
  name: string
  region: string
  code: string | null
  totalBuses: number
  liveBuses: number
}

interface PublicBus {
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
  lastLat: number | null
  lastLng: number | null
  lastSpeed: number
  lastGpsAt: string | null
  activeTrip: { id: string; status: string; currentStopIndex: number; startTime: string } | null
}

export default function LandingPage() {
  const [saccos, setSaccos] = useState<PublicSacco[]>([])
  const [expandedSaccoId, setExpandedSaccoId] = useState<string | null>(null)
  const [buses, setBuses] = useState<PublicBus[]>([])
  const [loadingBuses, setLoadingBuses] = useState(false)
  const [query, setQuery] = useState('')

  // ─── Load SACCOs on mount ──────────────────────────────────────
  useEffect(() => {
    fetch('/api/public/saccos')
      .then(r => r.json())
      .then(data => {
        setSaccos(data.saccos ?? [])
        // Auto-expand the first SACCO that has live buses
        const firstLive = (data.saccos ?? []).find((s: PublicSacco) => s.liveBuses > 0)
        if (firstLive) setExpandedSaccoId(firstLive.id)
      })
      .catch(e => console.error('Failed to load SACCOs', e))
  }, [])

  // ─── Load buses when a SACCO is expanded ───────────────────────
  useEffect(() => {
    if (!expandedSaccoId) {
      setBuses([])
      return
    }
    setLoadingBuses(true)
    fetch(`/api/public/buses?saccoId=${encodeURIComponent(expandedSaccoId)}`)
      .then(r => r.json())
      .then(data => setBuses(data.buses ?? []))
      .catch(e => console.error('Failed to load buses', e))
      .finally(() => setLoadingBuses(false))
  }, [expandedSaccoId])

  // Auto-refresh live bus data every 15s so the landing dot stays fresh
  useEffect(() => {
    if (!expandedSaccoId) return
    const id = setInterval(() => {
      fetch(`/api/public/buses?saccoId=${encodeURIComponent(expandedSaccoId)}`)
        .then(r => r.json())
        .then(data => setBuses(data.buses ?? []))
        .catch(() => {})
    }, 15000)
    return () => clearInterval(id)
  }, [expandedSaccoId])

  const filteredSaccos = saccos.filter(s => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.region.toLowerCase().includes(q) ||
      (s.code ?? '').toLowerCase().includes(q)
    )
  })

  const expandedSacco = saccos.find(s => s.id === expandedSaccoId)

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50 to-white">
      {/* ─── Top nav ───────────────────────────────────────────── */}
      <nav className="sticky top-0 z-40 bg-blue-800 text-white shadow-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-yellow-400 flex items-center justify-center shadow-md">
              <Bus className="w-5 h-5 text-blue-900" />
            </div>
            <span className="text-lg font-bold tracking-tight">MatatuLink</span>
          </Link>
          <div className="flex items-center gap-1">
            <Link
              href="/passenger"
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

      {/* ─── Hero ──────────────────────────────────────────────── */}
      <section className="bg-gradient-to-br from-blue-900 via-blue-800 to-blue-950 text-white">
        <div className="max-w-6xl mx-auto px-4 py-12 md:py-20 grid md:grid-cols-2 gap-8 items-center">
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
              <Link
                href="/passenger"
                className="inline-flex items-center gap-2 border border-blue-400 text-white px-5 py-2.5 rounded-lg font-semibold hover:bg-blue-700/50 transition-colors"
              >
                I already know my bus
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          {/* Feature pills */}
          <div className="grid grid-cols-2 gap-3">
            <FeatureCard
              icon={<Wifi className="w-5 h-5" />}
              title="Works offline"
              body="Board + pay in dead zones. Syncs when you reconnect."
            />
            <FeatureCard
              icon={<CreditCard className="w-5 h-5" />}
              title="M-Pesa, cash, card"
              body="Pay how you want. Conductor sees it instantly."
            />
            <FeatureCard
              icon={<Navigation className="w-5 h-5" />}
              title="Live GPS"
              body="See the bus move. Know your stop is coming up."
            />
            <FeatureCard
              icon={<ShieldCheck className="w-5 h-5" />}
              title="No double-charge"
              body="Every booking has a unique ID. Safe replay on reconnect."
            />
          </div>
        </div>
      </section>

      {/* ─── Find your matatu ──────────────────────────────────── */}
      <section id="find-matatu" className="max-w-6xl w-full mx-auto px-4 py-10 md:py-14">
        <div className="mb-6">
          <h2 className="text-2xl md:text-3xl font-bold text-blue-900">
            Find your matatu
          </h2>
          <p className="text-gray-600 text-sm mt-1">
            Pick your SACCO to see live buses. Tap a bus to choose your seat.
          </p>
        </div>

        {/* Search bar */}
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

        {/* SACCO list */}
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
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {filteredSaccos.map(sacco => {
              const isExpanded = sacco.id === expandedSaccoId
              return (
                <Card
                  key={sacco.id}
                  className={`cursor-pointer transition-all ${
                    isExpanded ? 'ring-2 ring-blue-600 shadow-md' : 'hover:shadow-md'
                  }`}
                  onClick={() => setExpandedSaccoId(isExpanded ? null : sacco.id)}
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
                    <Button
                      size="sm"
                      variant={isExpanded ? 'default' : 'outline'}
                      className="w-full mt-3"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedSaccoId(isExpanded ? null : sacco.id)
                      }}
                    >
                      {isExpanded ? 'Hide buses' : 'Show buses'}
                      <ArrowRight className={`w-3.5 h-3.5 ml-1 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        {/* Expanded bus list */}
        {expandedSacco && (
          <div className="bg-white rounded-xl border border-blue-100 shadow-sm">
            <div className="px-5 py-4 border-b border-blue-50 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-blue-900">{expandedSacco.name}</h3>
                <p className="text-xs text-gray-500">
                  {expandedSacco.region} · {buses.length} bus{buses.length !== 1 ? 'es' : ''} total
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
                  <BusRow key={bus.id} bus={bus} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ─── Three interfaces ─────────────────────────────────── */}
      <section className="bg-blue-50/50 border-t border-blue-100">
        <div className="max-w-6xl mx-auto px-4 py-12">
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
              href="/passenger"
              cta="Open passenger app"
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

      {/* ─── Footer ───────────────────────────────────────────── */}
      <footer className="bg-blue-900 text-blue-100 py-6">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between text-xs flex-wrap gap-2">
          <span>© 2026 MatatuLink · Built for Kenyan SACCOs</span>
          <div className="flex items-center gap-3">
            <Link href="/passenger" className="hover:text-white">Passenger</Link>
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
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </CardContent>
    </Card>
  )
}

function BusRow({ bus }: { bus: PublicBus }) {
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

        {/* Seat availability bar */}
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

        <Link
          href={`/passenger?bus=${encodeURIComponent(bus.id)}`}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            available === 0
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed pointer-events-none'
              : 'bg-blue-700 text-white hover:bg-blue-800'
          }`}
          aria-disabled={available === 0}
        >
          {available === 0 ? 'Full' : 'Board this matatu'}
          {available > 0 && <ArrowRight className="w-3.5 h-3.5" />}
        </Link>
      </div>
    </div>
  )
}
