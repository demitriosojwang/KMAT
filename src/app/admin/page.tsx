'use client'

/**
 * /admin — SACCO owner / matatu owner interface.
 *
 * Auth-gated (NextAuth SACCO owner credentials). Once signed in, the
<<<<<<< HEAD
 * admin sees the existing OwnerPanel:
 *   - Live fleet map (all buses in the SACCO, real-time GPS)
 *   - Revenue dashboard (today / trip / per-bus breakdown)
 *   - Route manager (CSV upload, fare matrix editor)
 *   - Bus manager (add/remove buses, assign routes)
 *   - Fleet-wide alerts (off-route, payment anomalies)
 *
 * This is the only screen that sees cross-bus aggregates — the
 * crew/passenger views are intentionally per-bus only.
=======
 * admin sees the OwnerPanel: live fleet map, revenue dashboard,
 * route manager (CSV upload), bus manager, fleet-wide alerts.
>>>>>>> 26416a0 (Restructure: passenger-first landing + crew + admin interfaces)
 */
import React from 'react'
import { Bus, RotateCcw } from 'lucide-react'

import { useSaccoSession } from '@/hooks/use-sacco-session'
import { SignInCard } from '@/components/shell/sign-in-card'
import { CrewAdminHeader } from '@/components/shell/crew-admin-header'
import { OwnerPanel } from '@/components/owner-panel'

export default function AdminPage() {
  const s = useSaccoSession()

<<<<<<< HEAD
  // ─── Loading ──────────────────────────────────────────────────
=======
>>>>>>> 26416a0 (Restructure: passenger-first landing + crew + admin interfaces)
  if (s.auth.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-blue-50/50">
        <div className="text-center animate-in fade-in zoom-in-95 duration-200">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-700 flex items-center justify-center animate-pulse">
            <Bus className="w-8 h-8 text-yellow-300" />
          </div>
          <h2 className="text-xl font-bold text-blue-900">MatatuLink</h2>
          <p className="text-blue-600 text-sm mt-1">Loading admin console…</p>
        </div>
      </div>
    )
  }

<<<<<<< HEAD
  // ─── Unauthenticated → sign-in card ───────────────────────────
=======
>>>>>>> 26416a0 (Restructure: passenger-first landing + crew + admin interfaces)
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
        tagline="Kenyan Matatu System · SACCO Owner Sign-in"
      />
    )
  }

<<<<<<< HEAD
  // ─── Authenticated admin console ──────────────────────────────
=======
>>>>>>> 26416a0 (Restructure: passenger-first landing + crew + admin interfaces)
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50/80 to-white">
      <CrewAdminHeader
        section="admin"
        ownerMeta={s.auth.ownerMeta}
        busList={s.busList}
        selectedBusId={s.selectedBusId}
        onSelectBus={s.setSelectedBusId}
        onSignOut={s.handleSignOut}
      />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6">
        <div className="animate-in fade-in slide-in-from-bottom-3 duration-200">
          <OwnerPanel
            busData={s.busData}
            tripData={s.tripData}
            stops={s.stops}
            seats={s.seats}
            currentStopIndex={s.currentStopIndex}
            transactions={s.transactions}
            gpsData={s.gpsData}
            fleetData={s.fleetData}
            ownerId={s.auth.ownerId}
            onRefresh={() => { s.refreshBusData(); s.refreshFleetData() }}
            onReset={s.handleReset}
          />
        </div>
      </main>

<<<<<<< HEAD
      {/* Footer */}
=======
>>>>>>> 26416a0 (Restructure: passenger-first landing + crew + admin interfaces)
      <footer className="mt-auto border-t bg-white py-3">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between text-xs text-gray-500">
          <span>© 2026 MatatuLink · Admin Console</span>
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
