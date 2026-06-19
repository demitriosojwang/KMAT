'use client'

import { SessionProvider as NextAuthSessionProvider } from 'next-auth/react'
import React from 'react'

/**
 * Client-side wrapper around next-auth/react's SessionProvider.
 * Mount this once near the root of the client tree to enable
 * useSession() in any descendant component.
 */
export function SessionProvider({ children, session }: { children: React.ReactNode; session?: any }) {
  return <NextAuthSessionProvider session={session}>{children}</NextAuthSessionProvider>
}
