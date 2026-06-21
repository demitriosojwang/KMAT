# MatatuLink — ponytail-audit

One-shot, repo-wide audit for over-engineering. Scope: complexity only.
Correctness bugs, security holes, and performance are explicitly out of scope
(route them to a normal review pass). Lists findings, applies nothing.

Methodology: ponytail ladder (YAGNI → stdlib → native → installed dep →
one-liner → minimum). Tags: `delete` / `stdlib` / `native` / `yagni` /
`shrink`. Ranked biggest cut first.

---

## Findings

### 1. `src/app/page.tsx` — 4224 LOC, four panels in one file
**Tag:** `yagni` — one file doing four unrelated jobs.

Split into four route segments, each its own client component:

```
src/app/(passenger)/page.tsx        → PassengerPanel   (~850 LOC)
src/app/(conductor)/page.tsx        → ConductorPanel   (~610 LOC)
src/app/(driver)/page.tsx           → DriverPanel      (~380 LOC)
src/app/(owner)/page.tsx            → OwnerPanel + BusManager + RouteManager (~870 LOC)
src/app/page.tsx                    → router shell that redirects by role/tab (~80 LOC)
src/lib/types.ts                    → shared Stop/Passenger/Seat/BusData/TripData/Transaction types (~80 LOC)
src/lib/fare.ts                     → computeFare + SEAT_COLORS + getSeatColor (~60 LOC)
src/components/leaflet-dynamic.ts   → MapContainer/TileLayer/Marker/Popup/Polyline dynamic imports + MapRecenter (~40 LOC)
```

**Why this is the #1 finding:** every other audit row is a 50-line cleanup.
This one is structural — it determines whether the next 6 months of work
(crew offline, geofencing, fleet view) happens in a sane codebase or in a
5,000-line file. The "fewest files possible" rule does **not** mean "one
file for everything"; it means "no file doing two unrelated jobs." Four
panels × two unrelated jobs each = eight.

**Replacement:** the route structure above. Passenger/Conductor/Driver/Owner
never share state in the same render tree — they're different users on
different devices. The current single-page tab switch is a dev convenience,
not a product requirement. Each panel can be its own route, lazy-loaded.

**Net: −4224 LOC in `src/app/page.tsx`, +~2900 LOC across 8 new files. Real
net: ~−1300 LOC because the split forces us to delete duplicated props,
inline comment headers per panel, and the 60-line TabType switch.**

---

### 2. `src/hooks/use-toast.ts` — 193 LOC, dead code
**Tag:** `delete` — `src/app/layout.tsx` already mounts `<Toaster from="sonner" />`
and `src/app/page.tsx` imports `{ toast } from 'sonner'`. Nothing in `src/`
imports `useToast` from `@/hooks/use-toast` except `src/components/ui/toaster.tsx`,
and **`<Toaster />` from `@/components/ui/toaster` is never mounted anywhere.**

```
src/hooks/use-toast.ts          → delete (193 LOC)
src/components/ui/toaster.tsx   → delete (16 LOC)
src/components/ui/toast.tsx     → delete (128 LOC)
```

`sonner` is the active toast system. The shadcn toast triple is leftover
from the initial `shadcn init` and was never wired in.

**Net: −337 LOC, −0 deps (toast.tsx imports only Radix, already used elsewhere).**

---

### 3. 15 unused production dependencies in `package.json`
**Tag:** `delete` — `rg -l <pkg> src/` returns zero hits for each:

```
@dnd-kit/core            @dnd-kit/sortable          @dnd-kit/utilities
@hookform/resolvers      @mdxeditor/editor          @reactuses/core
@tanstack/react-query    @tanstack/react-table      date-fns
next-intl                react-markdown             react-syntax-highlighter
tailwindcss-animate      uuid                       zustand
```

`uuid` is especially telling — `src/app/page.tsx:1064` already uses the
native `crypto.randomUUID()`. We have the stdlib version, we just also ship
the npm one.

**Net: −15 deps. LOC: 0 (deps don't add LOC, but they add `bun install`
time, bundle size when accidentally imported, and CVE surface).**

---

### 4. 35 of 39 shadcn/ui components never imported
**Tag:** `delete` — `rg -l ui/<name> src/` (excluding `src/components/ui/`
itself) returns zero hits for everything except `badge`, `button`, `card`,
`dialog`:

```
Used (4):    badge, button, card, dialog
Unused (35): accordion, alert, alert-dialog, aspect-ratio, avatar,
             breadcrumb, calendar, carousel, chart, checkbox, collapsible,
             command, context-menu, drawer, dropdown-menu, form, hover-card,
             input-otp, menubar, navigation-menu, pagination, popover,
             radio-group, resizable, scroll-area, sheet, sidebar, skeleton,
             slider, sonner, switch, table, toaster, toggle, toggle-group,
             tooltip
```

`src/components/ui/sonner.tsx` is doubly dead — we already import `Toaster`
from `sonner` directly in `layout.tsx`.

The bigger dead-weight items by LOC:
- `sidebar.tsx` (726 LOC), `chart.tsx` (353 LOC), `menubar.tsx` (276 LOC),
  `dropdown-menu.tsx` (257 LOC), `context-menu.tsx` (252 LOC),
  `carousel.tsx` (241 LOC), `calendar.tsx` (213 LOC).

**Caveat:** some of these (dropdown-menu, popover, tooltip, scroll-area,
skeleton) are likely to come back the moment we build crew-side offline
panels. The ponytail call here is **not** "delete all 35 now" — it's
"delete the 25 that have no plausible Phase 4 use, keep the 10 that do."
Specifically delete: `accordion, alert-dialog, aspect-ratio, avatar,
breadcrumb, calendar, carousel, chart, command, context-menu, drawer,
form, hover-card, input-otp, menubar, navigation-menu, pagination,
resizable, sheet, sidebar, table, toaster, toggle-group, sonner.tsx`.

**Net: ~−3500 LOC, −3 transitive deps (chart → recharts is used elsewhere
so recharts stays; carousel → embla-carousel-react can go; command → cmdk
can go; input-otp → input-otp can go).**

---

### 5. `computeSpeedStats` in `src/lib/gps-intelligence.ts` — dead function
**Tag:** `delete` — exported but never imported anywhere. 19 LOC.

```ts
// lines 286-302
export interface SpeedStats { ... }
export function computeSpeedStats(history: GPSReading[]): SpeedStats { ... }
```

**Net: −19 LOC.**

---

### 6. `findNearestUpcomingStop` — partly dead
**Tag:** `shrink` — exported, called once from `src/app/api/gps/route.ts:78`
but **its return value is shipped in the response and never read by the
client** (rg `nearestUpcomingStop` in `src/app/page.tsx` → zero hits
outside the GPS panel's `gpsData` object, which itself doesn't render it).

Either (a) delete the field from the response and the function, or (b)
actually render it in the DriverPanel. Lean (a) until the driver panel
asks for it.

**Net: −15 LOC if deleted, or wire it up if it's a real product gap.**

---

### 7. `clearSyncedPayments` in `src/lib/offline-db.ts` — dead function
**Tag:** `delete` — exported, never imported. 7 LOC. Also note
`markPaymentSynced` already deletes the row inline (line 114: `await
db.delete("paymentQueue", id)`), so a separate purge pass is redundant.

**Net: −7 LOC.**

---

### 8. `getCache` in `src/lib/offline-db.ts` — duplicate of `getCacheStale`
**Tag:** `shrink` — `getCache` returns `{value, cachedAt} | null` and
expires-on-TTL. `getCacheStale` returns the same plus `isStale` and does
NOT expire-on-TTL (it returns stale data with a flag). Every caller in
`src/` uses `getCacheStale`. `getCache` has zero callers. Delete `getCache`,
keep `getCacheStale`.

**Net: −9 LOC.**

---

### 9. Hand-rolled try/catch boilerplate in every API route
**Tag:** `yagni` — every API route wraps its body in:

```ts
try {
  // ... route body ...
} catch (error) {
  console.error("Error <verb>:", error);
  return NextResponse.json({ error: "Failed" }, { status: 500 });
}
```

That's 4-6 copies per route × 11 routes = ~50 copies. Next.js 16 supports
`route` segment config + a route handler wrapper that does this in one
place. Or — ponytail ultra — drop the catch entirely and let Next's
default 500 handler do its job, since the message is always `"Failed"`
anyway (zero debugging value).

Middle ground: one `withErrors(handler)` wrapper in `src/lib/api.ts`:

```ts
export const withErrors = <T extends (...a: any[]) => any>(h: T): T =>
  (async (...a: any[]) => {
    try { return await h(...a) }
    catch (e) { console.error(e); return NextResponse.json({ error: "Failed" }, { status: 500 }) }
  }) as T
```

Then `export const POST = withErrors(async (req) => { ... })`.

**Net: −~200 LOC across 11 routes.** (Skip this if you want stack traces
visible per-route; the wrapper still logs them via `console.error(e)`.)

---

### 10. `next-intl` removed but locale routing plumbing not present either
**Tag:** `delete` (already covered in #3, but calling out separately) —
`next-intl` is in `package.json` but `rg "next-intl" src/` is empty. If
localization is a real Phase 4 requirement (Swahili UI), keep the dep and
wire it; if not, drop it. Don't ship a 0-KB import of an i18n framework.

---

### 11. `@tanstack/react-query` installed, never used
**Tag:** `delete` — every fetch in `src/app/page.tsx` is a hand-rolled
`useEffect + fetch + setState`. If we're keeping `react-query`, the
passenger panel's `loadBus`/`loadTrip`/`loadGps` calls should be
`useQuery` calls. If we're not, drop the dep.

The ponytail call: **drop it.** The current fetch pattern works, the
offline layer (SWR in `sw.js` + IndexedDB) already handles caching, and
adding `react-query` now means rewriting every fetch call for marginal
gain. Revisit when a panel actually needs optimistic updates + cache
invalidation (probably never on passenger side; maybe on conductor side).

**Net: −1 dep.** (Already counted in #3.)

---

### 12. `framer-motion` — 1 file, ~10 motion components
**Tag:** `shrink` — `src/app/page.tsx` imports `motion, AnimatePresence`
and uses them in ~10 places for tab transitions and banner animations.
All current uses are simple opacity/slide transitions that CSS does in
one line:

```tsx
// before — framer-motion
<motion.div
  initial={{ opacity: 0, y: 10 }}
  animate={{ opacity: 1, y: 0 }}
  exit={{ opacity: 0, y: -10 }}
>

// after — CSS, Tailwind 4
<div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
```

`tw-animate-css` is already a devDep — it ships the `animate-in` utilities.
This deletes the `framer-motion` dep entirely (~50 KB gzipped).

**Caveat:** if Phase 4 layout animations get more complex (drag-to-reorder
seats, spring physics), revisit. For now, the current 10 usages are
trivially CSS-able.

**Net: −1 dep, −~30 LOC of motion props replaced with className.**

---

### 13. `date-fns` — installed, never used
**Tag:** `delete` — covered in #3, but worth calling out: every timestamp
in `src/app/page.tsx` is formatted with `new Date(x).toLocaleTimeString()`.
`date-fns` would be a step up, but only if we actually use it. Either
commit to it or drop it. Ponytail says: drop.

---

### 14. `sacco-context.ts` — three-tier fallback hides bugs
**Tag:** `shrink` — `resolveSaccoContext` does:

1. NextAuth session → return
2. `?ownerId=` / `x-owner-id` header → return
3. First Owner row in DB → return

Tier 3 is the problem. In production it means **any unauthenticated
request silently impersonates the first SACCO's owner**. The comment
says "last-resort fallback for dev/seed" but the code path has no
`NODE_ENV` guard. Ponytail rule: "input validation at trust boundaries
is never on the chopping block" — but the *opposite* of that rule also
applies: don't add unrequested fallbacks that punch a hole in the
boundary.

**Replacement:**
```ts
// 1. NextAuth session → return
// 2. header/query override ONLY in dev:
if (process.env.NODE_ENV !== 'production') {
  // ... existing tier-2 code
}
// 3. NO first-owner fallback. Return null → caller returns 401.
```

**Net: −6 LOC, +1 security hole closed. Not strictly a ponytail finding
(scope is over-engineering, not security) but the fallback is itself
unrequested abstraction — tier 3 was never asked for.**

---

### 15. Repeated inline color maps in `src/app/page.tsx:156-179`
**Tag:** `shrink` — `PAYMENT_COLORS` and `SEAT_COLORS` are top-level
constants in the 4224-line file. Move to `src/lib/fare.ts` (proposed in
finding #1) — they're pure data, no React, no reason to live in a
component file.

**Net: 0 LOC, but enables the page.tsx split.**

---

## Summary

```
net: −~5300 lines possible, −19 deps possible (15 unused + 4 from UI cull).
```

### Ranked by impact

| # | Finding | LOC cut | Risk |
|---|---|---|---|
| 1 | Split `page.tsx` into 4 routes + lib files | ~1300 | Medium (real refactor) |
| 4 | Delete 25 unused shadcn/ui components | ~3500 | Low (rg verified) |
| 2 | Delete dead `use-toast` triple | 337 | Zero (dead code) |
| 9 | `withErrors` wrapper for API routes | ~200 | Low (mechanical) |
| 3 | Remove 15 unused production deps | 0 LOC | Low (rg verified) |
| 12 | Replace `framer-motion` with `tw-animate-css` | ~30 | Low (10 sites) |
| 14 | Remove tier-3 fallback in `sacco-context.ts` | 6 | Medium (auth) |
| 5 | Delete `computeSpeedStats` | 19 | Zero |
| 7 | Delete `clearSyncedPayments` | 7 | Zero |
| 8 | Delete `getCache` (keep `getCacheStale`) | 9 | Zero |
| 6 | Delete or wire `findNearestUpcomingStop` | 15 | Low |
| 13 | Delete `date-fns` | 0 | Zero (in #3) |
| 11 | Delete `@tanstack/react-query` | 0 | Zero (in #3) |
| 10 | Delete `next-intl` | 0 | Zero (in #3) |
| 15 | Move color maps to `lib/fare.ts` | 0 | Zero (enables #1) |

### Suggested triage order (cheapest safe wins first)

1. **Zero-risk deletes (findings 5, 7, 8, 13, 11, 10):** ~35 LOC + 4 deps in
   one PR. No behavior change. Ship today.
2. **Dead shadcn components (finding 4):** ~3500 LOC + 3 deps in one PR.
   Verify build still passes. Ship tomorrow.
3. **Dead toast triple (finding 2):** 337 LOC, one PR. Verify Sonner toasts
   still fire. Ship tomorrow.
4. **API `withErrors` wrapper (finding 9):** ~200 LOC, mechanical. One PR
   per route or one PR for all 11.
5. **sacco-context tier-3 removal (finding 14):** one PR, requires manual
   test that auth still works in dev (header override path) and prod
   (session-only path).
6. **framer-motion → CSS (finding 12):** one PR, 10 sites, requires visual
   QA on tab transitions.
7. **`page.tsx` split (finding 1):** the big one. Do this last, after the
   tree is lean. Otherwise the split happens into a still-bloated codebase
   and you can't see what's actually passenger-side vs conductor-side.

### Non-findings (deliberately left alone)

These are *not* on the cut list — ponytail "never simplify away" applies:

- `clientId @unique` idempotency in `prisma/schema.prisma` and the
  de-dupe branch in `src/app/api/passengers/route.ts:38-49`. Data-loss
  prevention. Keep.
- `try/catch` around `db.seat.update` and `db.trip.update` inside
  `POST /api/passengers`. Money path. Keep.
- `bcrypt.compare` in `nextauth/route.ts`. Security. Keep.
- Service Worker multi-strategy caching in `public/sw.js` (271 LOC).
  Each strategy handles a real offline scenario. Keep.
- IndexedDB `paymentQueue` + `cache` schema in `src/lib/offline-db.ts`.
  Two stores, each with a real caller. Keep.
- Haversine in `src/lib/gps-intelligence.ts`. 10 lines, correct, no
  external dep worth pulling in for one function. Keep.
- `MapRecenter` `try/catch` around `map.panTo`. Defensive against
  Leaflet's "map container not ready" race. Keep.

---

*Audit generated by applying the ponytail ladder to MatatuLink commit
8a81544. Read-only. No fixes applied.*
