'use client'

/**
 * /crew — combined conductor + driver interface.
 *
 * Auth-gated (NextAuth SACCO owner credentials). Once signed in, the
 * crew sees two tabs:
 *   - Conductor: board passengers, accept fares, broadcast messages,
 *     confirm alightings, manage seat occupancy.
 *   - Driver: advance stops, toggle GPS tracking, see next-stop info,
 *     view on-board counters + route progress.
 */
import React, { useState } from 'react'
import { UserCheck, Car, Bus, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useSaccoSession } from '@/hooks/use-sacco-session'
import { SignInCard } from '@/components/shell/sign-in-card'
import { CrewAdminHeader } from '@/components/shell/crew-admin-header'
import { ConductorPanel } from '@/components/conductor-panel'
import { DriverPanel } from '@/components/driver-panel'

type CrewTab = 'conductor' | 'driver'

export default function CrewPage() {
  const s = useSaccoSession()
  const [activeTab, setActiveTab] = useState<CrewTab>('conductor')

  if (s.auth.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-blue-50/50">
        <div className="text-center animate-in fade-in zoom-in-95 duration-200">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-700 flex items-center justify-center animate-pulse">
            <Bus className="w-8 h-8 text-yellow-300" />
          </div>
          <h2 className="text-xl font-bold text-blue-900">MatatuLink</h2>
          <p className="text-blue-600 text-sm mt-1">Loading crew console…</p>
        </div>
      </div>
    )
  }

  if (s.auth.status === 'unauthenticated') {
    return (
      <SignInCard
        signInEmail={s.signInEmail}
        signInPassword={s.signInPassword}
        setSignInEmail={s.setSignInEmail}
        setSignInPassword={s.setSignInPassword}
        signInLoading={s.signInLoading}
        onSignIn={s.handleSignIn}
        demoOwners={s.auth.demoOwners}
        tagline="Kenyan Matatu System · Crew Sign-in"
      />
    )
  }

  const tabs: { key: CrewTab; label: string; icon: React.ReactNode }[] = [
    { key: 'conductor', label: 'Conductor', icon: <UserCheck className="w-4 h-4" /> },
    { key: 'driver', label: 'Driver', icon: <Car className="w-4 h-4" /> },
  ]

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50/80 to-white">
      <CrewAdminHeader
        section="crew"
        ownerMeta={s.auth.ownerMeta}
        busList={s.busList}
        selectedBusId={s.selectedBusId}
        onSelectBus={s.setSelectedBusId}
        onSignOut={s.handleSignOut}
      />

      <div className="bg-blue-800 text-white">
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
      </div>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <div key={activeTab} className="animate-in fade-in slide-in-from-bottom-3 duration-200">
          {activeTab === 'conductor' && (
            <ConductorPanel
              busData={s.busData}
              tripData={s.tripData}
              stops={s.stops}
              seats={s.seats}
              currentStopIndex={s.currentStopIndex}
              emitSocket={s.emitSocket}
              notifications={s.notifications}
              onRefresh={s.refreshBusData}
            />
          )}
          {activeTab === 'driver' && (
            <DriverPanel
              busData={s.busData}
              tripData={s.tripData}
              stops={s.stops}
              seats={s.seats}
              currentStopIndex={s.currentStopIndex}
              passengersOnBoard={s.passengersOnBoard}
              gpsData={s.gpsData}
              emitSocket={s.emitSocket}
              notifications={s.notifications}
              onRefresh={() => { s.refreshBusData(); s.refreshTripData() }}
              fetchGpsData={s.refreshGpsData}
            />
          )}
        </div>
      </main>

      <footer className="mt-auto border-t bg-white py-3">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between text-xs text-gray-500">
          <span>© 2026 MatatuLink · Crew Console</span>
          <button
            onClick={s.handleReset}
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
