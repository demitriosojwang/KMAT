'use client'

/**
 * OwnerPanel — the SACCO owner's analytics + admin surface.
 *
 * Sub-components (kept in this file because they're owner-only and
 * tightly coupled to OwnerPanel's data flow):
 *   - RouteManager   — register numbered routes with stop coordinates + fares
 *   - BusManager     — add buses (14/33/11-seater), assign routes
 *
 * Owner-side surfaces:
 *   - SACCO identity banner (name, code, region, all-time stats)
 *   - Fleet overview stats (total/tracking/moving/idle/off-route/passengers)
 *   - Fleet bus list (live status per bus)
 *   - GPS intelligence bar (route progress / off-route / geofence / next-stop ETA)
 *   - ETA table to every stop on the selected bus's route
 *   - Route + Bus manager tabs
 *   - Multi-bus live fleet map (every bus on one map with its own polyline)
 *   - Single-bus live tracking map (focus on the selected bus)
 *   - Revenue cards (today's revenue, passengers, occupancy)
 *   - Revenue charts (by method, by stop, payment breakdown pie)
 *   - Seat occupancy mini-map
 *   - Active trip info + event log
 */
import React, { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Bus, Users, BarChart3, Armchair, MapPin,
  Navigation, ChevronRight, DollarSign, TrendingUp, PieChart as PieChartIcon,
  Building2, Plus, Route as RouteIcon, Upload, FileSpreadsheet, Clock, ArrowRight,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts'

import { PAYMENT_COLORS } from '@/lib/fare'
import type { BusData, GPSData, Seat, Stop, Transaction, TripData } from '@/lib/types'
import {
  MapContainer, TileLayer, Marker, Popup, Polyline, MapRecenter,
  useLeafletReady,
} from '@/components/leaflet-dynamic'

interface Props {
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
}

export function OwnerPanel({
  busData, tripData, stops, seats, currentStopIndex,
  transactions, gpsData, fleetData, ownerId, onRefresh, onReset,
}: Props) {
  void transactions  // reserved for a future owner-side transaction ledger
  void onReset       // reserved for a future owner-side "reset demo data" button

  const [ownerData, setOwnerData] = useState<any>(null)
  const leafletReady = useLeafletReady(true)

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
                      <Users className="w-4 h-4 text-blue-600" />
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
