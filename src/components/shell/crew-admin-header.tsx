'use client'

/**
 * CrewAdminHeader — shared top bar for /crew and /admin.
 * Logo + SACCO name + section nav (Passenger/Crew/Admin) + bus
 * selector + sign out.
 */
import Link from 'next/link'
import React from 'react'
import { Bus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BusListItem, OwnerMeta } from '@/hooks/use-sacco-session'

type Section = 'crew' | 'admin'

interface Props {
  section: Section
  ownerMeta: OwnerMeta | null
  busList: BusListItem[]
  selectedBusId: string | null
  onSelectBus: (id: string | null) => void
  onSignOut: () => Promise<void>
}

export function CrewAdminHeader({
  section, ownerMeta, busList, selectedBusId, onSelectBus, onSignOut,
}: Props) {
  return (
    <header className="sticky top-0 z-50 bg-blue-800 text-white shadow-lg">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <Link href="/" className="flex items-center gap-3 hover:opacity-90 transition-opacity">
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
        </Link>

        <nav className="flex items-center gap-1 order-3 md:order-2 w-full md:w-auto">
          <Link
            href="/"
            className="px-3 py-1.5 rounded-md text-xs font-medium text-blue-100 hover:bg-blue-700/50 hover:text-white transition-colors"
          >
            Passenger
          </Link>
          <Link
            href="/crew"
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              section === 'crew'
                ? 'bg-yellow-400 text-blue-900'
                : 'text-blue-100 hover:bg-blue-700/50 hover:text-white'
            }`}
          >
            Crew
          </Link>
          <Link
            href="/admin"
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              section === 'admin'
                ? 'bg-yellow-400 text-blue-900'
                : 'text-blue-100 hover:bg-blue-700/50 hover:text-white'
            }`}
          >
            Admin
          </Link>
        </nav>

        <div className="flex items-center gap-2 order-2 md:order-3">
          {busList.length > 0 && (
            <select
              value={selectedBusId ?? ''}
              onChange={e => onSelectBus(e.target.value || null)}
              className="bg-blue-900/60 text-white border border-blue-400 rounded-md px-2 py-1 text-xs"
              aria-label="Active bus"
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
            onClick={onSignOut}
            className="border-blue-400 text-blue-100 hover:bg-blue-700 hover:text-white"
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  )
}
