'use client'

/**
 * ConductorPanel — the conductor's crew-side surface.
 *
 * - Seat map with per-passenger detail dialog
 * - Board-passenger form (seat, name, phone, alighting, fare, payment method)
 * - Approaching-stops list (with one-click "Confirm Alight")
 * - Broadcast-message box (sends to all passengers via WS)
 * - Notification feed
 *
 * The conductor's role is NOT replaced by the app — this panel works
 * collaboratively with them. They can override fares, board walk-up
 * cash passengers, and broadcast messages the passenger PWA surfaces.
 */
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import {
  Armchair,
  UserCheck, Navigation, User, MessageSquare, Send,
  Bell as BellIcon,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

import { computeFare, getSeatColor } from '@/lib/fare'
import type { BusData, Seat, Stop, TripData, WSNotification } from '@/lib/types'

interface Props {
  busData: BusData | null
  tripData: TripData | null
  stops: Stop[]
  seats: Seat[]
  currentStopIndex: number
  emitSocket: (event: string, data: any) => void
  notifications: WSNotification[]
  onRefresh: () => void
}

export function ConductorPanel({
  busData, tripData, stops, seats, currentStopIndex, emitSocket, notifications, onRefresh,
}: Props) {
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
