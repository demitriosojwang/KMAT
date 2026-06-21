'use client'

/**
 * Dynamic Leaflet imports (SSR-safe) + MapRecenter helper.
 *
 * react-leaflet depends on `window`, so every Leaflet component must be
 * dynamically imported with `ssr: false`. The `useMap` hook must be
 * statically imported (it's a hook, not a component), but it's only
 * called inside components that are themselves dynamically loaded, so
 * the SSR boundary is preserved.
 */
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { useMap as useLeafletMap } from 'react-leaflet'

export const MapContainer = dynamic(
  () => import('react-leaflet').then(mod => mod.MapContainer),
  {
    ssr: false,
    loading: () => (
      <div
        style={{ height: '300px', background: '#f0fdf4', borderRadius: '8px' }}
        className="flex items-center justify-center text-blue-600 text-sm"
      >
        Loading map...
      </div>
    ),
  }
)

export const TileLayer = dynamic(
  () => import('react-leaflet').then(mod => mod.TileLayer),
  { ssr: false }
)

export const Marker = dynamic(
  () => import('react-leaflet').then(mod => mod.Marker),
  { ssr: false }
)

export const Popup = dynamic(
  () => import('react-leaflet').then(mod => mod.Popup),
  { ssr: false }
)

export const Polyline = dynamic(
  () => import('react-leaflet').then(mod => mod.Polyline),
  { ssr: false }
)

// Component that recenters the map when bus position changes
export function MapRecenter({ position }: { position: [number, number] | null }) {
  const map = useLeafletMap()
  useEffect(() => {
    if (map && position) {
      try { map.panTo(position, { animate: true, duration: 0.8 }) } catch {}
    }
  }, [map, position])
  return null
}

/**
 * Load Leaflet CSS + fix default marker icons on the client.
 * Returns true once Leaflet is ready to render. Idempotent — safe to
 * call from multiple panels.
 */
export function useLeafletReady(enabled: boolean): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!enabled || ready || typeof window === 'undefined') return
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'
      document.head.appendChild(link)
    }
    import('leaflet').then((L) => {
      delete (L.Icon.Default.prototype as any)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
        iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
      })
      setReady(true)
    }).catch(() => {
      setTimeout(() => setReady(false), 1000)
    })
  }, [enabled, ready])

  return ready
}
