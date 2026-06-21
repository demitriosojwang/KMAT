import { NextResponse } from "next/server";

/**
 * Wrap a Next.js route handler with a uniform try/catch that logs the
 * error and returns `{ error: "Failed" }` with HTTP 500. Avoids the
 * 4-6 copies of the same boilerplate per route.
 *
 * Usage:
 *   export const POST = withErrors(async (req) => { ... })
 *   export const GET = withErrors(async (req) => { ... })
 *
 * The wrapped handler may still return its own NextResponse for
 * expected errors (404, 400, etc.) — those bubble up unchanged.
 * Only unexpected throws get caught here.
 */
export function withErrors<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response | NextResponse<unknown>>,
): (...args: TArgs) => Promise<Response | NextResponse<unknown>> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error("[api] error:", error);
      return NextResponse.json({ error: "Failed" }, { status: 500 });
    }
  };
}
