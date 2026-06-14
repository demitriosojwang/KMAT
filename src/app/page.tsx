'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import {
  Bus, Users, UserCheck, Car, BarChart3,
  Armchair, MapPin, CreditCard, CheckCircle2,
  Phone, QrCode, Banknote, Nfc,
  Navigation, ChevronRight, Clock, DollarSign,
  MessageSquare, Send, RotateCcw,
  TrendingUp, PieChart as PieChartIcon, Activity,
  User, ArrowRight, Radio, Bell as BellIcon,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
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
}

interface Passenger {
  id: string
  name: string | null
  phone: string | null
  boardingStop: string
  alightingStop: string
  alightingStopOrder: number
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
  isOccupied: boolean
  passenger: Passenger | null
  busId: string
}

interface BusData {
  id: string
  name: string
  registrationNumber: string
  totalSeats: number
  route: { id: string; name: string; stops: Stop[] } | null
  seats: Seat[]
  sacco: { id: string; name: string }
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

// ─── Color helpers ────────────────────────────────────────────────
const PAYMENT_COLORS: Record<string, string> = {
  mpesa: '#16a34a',
  cash: '#eab308',
  qr: '#8b5cf6',
  nfc: '#f97316',
  card: '#06b6d4',
}

const SEAT_COLORS = {
  available: 'bg-emerald-100 border-emerald-400 hover:bg-emerald-200 cursor-pointer',
  occupied: 'bg-red-100 border-red-400',
  occupiedFar: 'bg-orange-100 border-orange-400',
  unpaid: 'bg-yellow-100 border-yellow-500 border-dashed',
  selected: 'bg-emerald-400 border-emerald-600 text-white',
}

function getSeatColor(seat: Seat, currentStopIndex: number): string {
  if (!seat.isOccupied) return SEAT_COLORS.available
  const p = seat.passenger
  if (!p) return SEAT_COLORS.available
  if (p.paymentStatus === 'unpaid' || p.paymentStatus === 'pending') return SEAT_COLORS.unpaid
  if (p.alightingStopOrder <= currentStopIndex + 2) return SEAT_COLORS.occupied
  return SEAT_COLORS.occupiedFar
}

// ─── Main Component ───────────────────────────────────────────────
type TabType = 'passenger' | 'conductor' | 'driver' | 'owner'

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabType>('passenger')
  const [busData, setBusData] = useState<BusData | null>(null)
  const [tripData, setTripData] = useState<TripData | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [notifications, setNotifications] = useState<WSNotification[]>([])
  const [loading, setLoading] = useState(true)
  const socketRef = useRef<Socket | null>(null)

  // ─── Data fetching ────────────────────────────────────────────
  const fetchBusData = useCallback(async () => {
    try {
      const res = await fetch('/api/bus')
      const data = await res.json()
      if (data.bus) setBusData(data.bus)
      if (data.trip) setTripData(data.trip)
      if (data.transactions) setTransactions(data.transactions)
    } catch (e) {
      console.error('Failed to fetch bus data', e)
    }
  }, [])

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

  // ─── Socket emit helpers (access ref in callbacks, not during render) ─
  const emitSocket = useCallback((event: string, data: any) => {
    socketRef.current?.emit(event, data)
  }, [])

  // ─── Initial load ─────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await fetchBusData()
      setLoading(false)
    }
    load()
  }, [fetchBusData])

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
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-emerald-50/50">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-500 flex items-center justify-center animate-pulse">
            <Bus className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-xl font-bold text-emerald-800">MatatuLink</h2>
          <p className="text-emerald-600 text-sm mt-1">Loading bus data...</p>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-emerald-50/80 to-white">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-emerald-700 text-white shadow-lg">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center shadow-md">
              <Bus className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">MatatuLink</h1>
              <p className="text-emerald-200 text-xs">Kenyan Matatu System</p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-semibold text-sm">{busData?.name || 'Loading...'}</p>
            <p className="text-emerald-200 text-xs">{busData?.registrationNumber} • {busData?.sacco?.name}</p>
          </div>
        </div>
      </header>

      {/* ─── Tab Bar ────────────────────────────────────────────── */}
      <div className="sticky top-[60px] z-40 bg-white border-b shadow-sm">
        <div className="max-w-5xl mx-auto px-2">
          <div className="flex">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium transition-all border-b-2 ${
                  activeTab === tab.key
                    ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50'
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
                emitSocket={emitSocket}
                notifications={notifications}
                onRefresh={() => { fetchBusData(); fetchTripData() }}
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
                onRefresh={() => { fetchBusData() }}
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
  emitSocket,
  onRefresh,
}: {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
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
  const fare = selectedStopData ? (selectedStopData.order - (currentStopIndex + 1)) * 20 + 30 : 0

  const handleSeatClick = (seatNum: number) => {
    const seat = seats.find(s => s.number === seatNum)
    if (seat && !seat.isOccupied) {
      setSelectedSeat(seatNum)
    }
  }

  const handlePay = async () => {
    if (!selectedSeat || !selectedStop || !paymentMethod) return
    if (paymentMethod === 'mpesa' && !mpesaPhone) {
      toast.error('Please enter your M-Pesa phone number')
      return
    }

    setProcessing(true)
    try {
      const stopOrder = selectedStopData?.order || 1
      const res = await fetch('/api/passengers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: null,
          phone: paymentMethod === 'mpesa' ? mpesaPhone : null,
          seatNumber: selectedSeat,
          boardingStop: stops[currentStopIndex]?.name || 'Unknown',
          alightingStop: customStop || selectedStop,
          alightingStopOrder: stopOrder,
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
            alightingStop: customStop || selectedStop,
            alightingStopOrder: stopOrder,
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
          className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center mb-6"
        >
          <CheckCircle2 className="w-10 h-10 text-emerald-600" />
        </motion.div>
        <h2 className="text-2xl font-bold text-emerald-800 mb-2">You&apos;re all set! 🎉</h2>
        <p className="text-gray-600">Seat {selectedSeat} • {customStop || selectedStop}</p>
        <p className="text-emerald-600 font-semibold mt-1">KES {fare}</p>
      </motion.div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-bold text-emerald-800">Welcome aboard! 🚌</h2>
        <p className="text-gray-500 mt-1">Select your seat and destination</p>
      </div>

      {/* Step indicators */}
      <div className="flex items-center justify-center gap-2">
        {[1, 2, 3].map(s => (
          <React.Fragment key={s}>
            <button
              onClick={() => s < step && setStep(s)}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                step === s ? 'bg-emerald-600 text-white scale-110' :
                s < step ? 'bg-emerald-200 text-emerald-700' :
                'bg-gray-100 text-gray-400'
              }`}
            >
              {s < step ? <CheckCircle2 className="w-4 h-4" /> : s}
            </button>
            {s < 3 && <div className={`w-12 h-0.5 ${s < step ? 'bg-emerald-400' : 'bg-gray-200'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 1: Seat Map */}
      {step === 1 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Armchair className="w-5 h-5 text-emerald-600" />
              Pick Your Seat
            </CardTitle>
            <CardDescription>
              <span className="flex items-center gap-3 text-xs mt-1">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-400" /> Available</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 border border-red-400" /> Occupied</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-400 border border-emerald-600" /> Selected</span>
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
                  className="bg-emerald-600 hover:bg-emerald-700"
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
              <MapPin className="w-5 h-5 text-emerald-600" />
              Select Your Stop
            </CardTitle>
            <CardDescription>Where are you getting off?</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
              {stops.filter(s => s.order > currentStopIndex).map(stop => (
                <button
                  key={stop.id}
                  onClick={() => { setSelectedStop(stop.name); setCustomStop('') }}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                    selectedStop === stop.name
                      ? 'border-emerald-500 bg-emerald-50'
                      : 'border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/30'
                  }`}
                >
                  <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 font-bold text-xs shrink-0">
                    {stop.order}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{stop.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className="text-xs">
                        {stop.isStage ? 'Stage' : 'Custom'}
                      </Badge>
                      <span className="text-xs text-gray-500">
                        KES {((stop.order - (currentStopIndex + 1)) * 20 + 30)}
                      </span>
                    </div>
                  </div>
                  {selectedStop === stop.name && (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  )}
                </button>
              ))}
            </div>

            <Separator />

            <div>
              <p className="text-sm font-medium text-gray-600 mb-2">Or enter a custom stop:</p>
              <Input
                placeholder="e.g., Near Naivas Supermarket"
                value={customStop}
                onChange={e => { setCustomStop(e.target.value); setSelectedStop('') }}
                className="text-sm"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button
                onClick={() => setStep(3)}
                disabled={!selectedStop && !customStop}
                className="bg-emerald-600 hover:bg-emerald-700 flex-1"
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
              <CreditCard className="w-5 h-5 text-emerald-600" />
              Payment
            </CardTitle>
            <CardDescription>Choose your payment method</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-emerald-50 rounded-lg p-4 text-center">
              <p className="text-sm text-emerald-600">Total Fare</p>
              <p className="text-3xl font-bold text-emerald-800">KES {fare}</p>
              <p className="text-xs text-emerald-500 mt-1">
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
                      ? 'border-emerald-500 bg-emerald-50'
                      : 'border-gray-200 hover:border-emerald-300'
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
                className="bg-emerald-600 hover:bg-emerald-700 flex-1"
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
        <Card className="bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200">
          <CardContent className="p-4">
            <h4 className="font-semibold text-emerald-800 text-sm mb-2">Your Trip Summary</h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2">
                <Armchair className="w-4 h-4 text-emerald-600" />
                <span className="text-gray-600">Seat:</span>
                <span className="font-medium">{selectedSeat}</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-emerald-600" />
                <span className="text-gray-600">To:</span>
                <span className="font-medium truncate">{customStop || selectedStop || '—'}</span>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-emerald-600" />
                <span className="text-gray-600">Fare:</span>
                <span className="font-medium">KES {fare}</span>
              </div>
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-emerald-600" />
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

  const handleBoard = async () => {
    if (!boardSeat || !boardAlighting || !boardFare) {
      toast.error('Please fill in required fields')
      return
    }
    setBoarding(true)
    try {
      const alightingStopData = stops.find(s => s.name === boardAlighting)
      const res = await fetch('/api/passengers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: boardName || null,
          phone: boardPhone || null,
          seatNumber: parseInt(boardSeat),
          boardingStop: stops[currentStopIndex]?.name || 'Unknown',
          alightingStop: boardCustomStop || boardAlighting,
          alightingStopOrder: alightingStopData?.order || 1,
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
            alightingStop: boardCustomStop || boardAlighting,
            alightingStopOrder: alightingStopData?.order || 1,
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
              <Armchair className="w-5 h-5 text-emerald-600" />
              Seat Map
            </CardTitle>
            <CardDescription>
              <span className="flex flex-wrap items-center gap-2 text-xs mt-1">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-400" /> Free</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 border border-red-400" /> Alighting soon</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-100 border border-orange-400" /> Far stop</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-100 border border-yellow-500 border-dashed" /> Unpaid</span>
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
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
                              <Badge variant={seat.passenger.paymentStatus === 'paid' ? 'default' : 'destructive'}>
                                {seat.passenger.paymentStatus}
                              </Badge>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {seat.passenger.paymentStatus !== 'paid' && (
                              <Button
                                size="sm"
                                onClick={() => handleMarkPaid(seat.passenger!.id, seat.passenger!.fare)}
                                className="bg-emerald-600 hover:bg-emerald-700"
                              >
                                Mark Paid
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleAlight(seat.passenger!.id, seat.number)}
                            >
                              Confirm Alight
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    )}
                  </Dialog>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Board New Passenger */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <User className="w-5 h-5 text-emerald-600" />
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
              className="bg-emerald-600 hover:bg-emerald-700 mt-4 w-full"
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
                      p.alightingStopOrder <= currentStopIndex + 1
                        ? 'border-red-300 bg-red-50'
                        : 'border-amber-300 bg-amber-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{p.name || 'Passenger'}</p>
                        <p className="text-xs text-gray-500">
                          Seat {p.seat?.number} → {p.alightingStop}
                        </p>
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
                          className="bg-emerald-600 hover:bg-emerald-700 text-xs"
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
              <MessageSquare className="w-5 h-5 text-emerald-600" />
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
              className="bg-emerald-600 hover:bg-emerald-700 w-full"
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
              <BellIcon className="w-5 h-5 text-emerald-600" />
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
  emitSocket,
  notifications,
  onRefresh,
}: {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  passengersOnBoard: Passenger[]
  emitSocket: (event: string, data: any) => void
  notifications: WSNotification[]
  onRefresh: () => void
}) {
  const [advancing, setAdvancing] = useState(false)

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

  return (
    <div className="space-y-6">
      {/* Current Stop - Large Display */}
      <Card className="bg-gradient-to-br from-emerald-600 to-emerald-800 text-white">
        <CardContent className="p-6 text-center">
          <p className="text-emerald-200 text-sm font-medium mb-1">Current Stop</p>
          <h2 className="text-3xl font-bold mb-2">{currentStop?.name || 'Unknown'}</h2>
          <p className="text-emerald-200 text-sm">Stop {currentStopIndex + 1} of {stops.length}</p>

          {nextStop && (
            <Button
              size="lg"
              onClick={handleArrived}
              disabled={advancing}
              className="mt-4 bg-white text-emerald-800 hover:bg-emerald-50 font-bold text-lg px-8"
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

      {/* Counters */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <Users className="w-6 h-6 text-emerald-600 mx-auto mb-1" />
            <p className="text-2xl font-bold text-emerald-800">{occupiedCount}</p>
            <p className="text-xs text-gray-500">On Board</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Armchair className="w-6 h-6 text-emerald-600 mx-auto mb-1" />
            <p className="text-2xl font-bold text-emerald-800">{emptyCount}</p>
            <p className="text-xs text-gray-500">Empty Seats</p>
          </CardContent>
        </Card>
      </div>

      {/* Route Progress */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Navigation className="w-5 h-5 text-emerald-600" />
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
                  i <= currentStopIndex ? 'text-emerald-600' : 'text-gray-400'
                }`}
              >
                <div
                  className={`w-3 h-3 rounded-full mb-1 ${
                    i < currentStopIndex ? 'bg-emerald-500' :
                    i === currentStopIndex ? 'bg-emerald-500 pulse-emerald' :
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
            <Activity className="w-5 h-5 text-emerald-600" />
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
// OWNER PANEL
// ═══════════════════════════════════════════════════════════════════
function OwnerPanel({
  busData,
  tripData,
  stops,
  seats,
  currentStopIndex,
  transactions,
  onRefresh,
  onReset,
}: {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  transactions: Transaction[]
  onRefresh: () => void
  onReset: () => void
}) {
  const [ownerData, setOwnerData] = useState<any>(null)

  useEffect(() => {
    const fetchOwner = async () => {
      try {
        const res = await fetch('/api/owner')
        const data = await res.json()
        setOwnerData(data)
      } catch (e) {
        console.error('Failed to fetch owner data', e)
      }
    }
    fetchOwner()
  }, [tripData])

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

  return (
    <div className="space-y-6">
      {/* Revenue Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Card className="bg-gradient-to-br from-emerald-500 to-emerald-700 text-white">
          <CardContent className="p-4">
            <DollarSign className="w-6 h-6 mb-1 opacity-80" />
            <p className="text-2xl font-bold">KES {todayRevenue.toLocaleString()}</p>
            <p className="text-emerald-200 text-sm">Today&apos;s Revenue</p>
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
              <BarChart3 className="w-5 h-5 text-emerald-600" />
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
              <PieChartIcon className="w-5 h-5 text-emerald-600" />
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
              <Armchair className="w-5 h-5 text-emerald-600" />
              Seat Occupancy
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 gap-1.5">
              {seats.map(seat => {
                const isOccupied = occupiedSet.has(seat.number)
                const p = seat.passenger
                let bgColor = 'bg-emerald-100 border-emerald-300'
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
            <div className="flex gap-3 mt-3 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" /> Free</span>
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
              <MapPin className="w-5 h-5 text-emerald-600" />
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
            <Bus className="w-5 h-5 text-emerald-600" />
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
              <p className="font-semibold text-emerald-600">KES {todayRevenue.toLocaleString()}</p>
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
            <Clock className="w-5 h-5 text-emerald-600" />
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
                    event.type === 'boarded' ? 'bg-emerald-100' : 'bg-blue-100'
                  }`}>
                    {event.type === 'boarded' ? (
                      <User className="w-4 h-4 text-emerald-600" />
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
