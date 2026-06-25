'use client'

/**
 * SignInCard — NextAuth credentials form, used by /crew and /admin
 * when the visitor is not yet signed in. Renders demo-account
 * click-to-prefill buttons from /api/me.
 */
import React from 'react'
import { LogIn, Mail, Lock, Bus } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SaccoOwnerLite } from '@/hooks/use-sacco-session'

interface Props {
  signInEmail: string
  signInPassword: string
  setSignInEmail: (v: string) => void
  setSignInPassword: (v: string) => void
  signInLoading: boolean
  onSignIn: (e: React.FormEvent) => Promise<void>
  demoOwners: SaccoOwnerLite[]
  tagline?: string
}

export function SignInCard({
  signInEmail, signInPassword, setSignInEmail, setSignInPassword,
  signInLoading, onSignIn, demoOwners, tagline,
}: Props) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-blue-800 to-blue-950 p-4">
      <div className="w-full max-w-md animate-in fade-in slide-in-from-bottom-5 duration-300">
        <div className="text-center mb-6">
          <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-yellow-400 flex items-center justify-center shadow-xl">
            <Bus className="w-8 h-8 text-blue-900" />
          </div>
          <h1 className="text-2xl font-bold text-white">MatatuLink</h1>
          <p className="text-blue-200 text-sm mt-1">
            {tagline ?? 'Kenyan Matatu System · Staff Sign-in'}
          </p>
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
            <form onSubmit={onSignIn} className="space-y-3">
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

            {demoOwners.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
                  Demo accounts (click to prefill)
                </p>
                <div className="space-y-1.5">
                  {demoOwners.map(o => (
                    <button
                      key={o.email}
                      onClick={() => {
                        setSignInEmail(o.email)
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
