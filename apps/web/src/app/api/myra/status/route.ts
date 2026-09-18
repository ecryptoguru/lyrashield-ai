/**
 * GET /api/myra/status — public capability probe for the marketing site.
 *
 * The marketing surface must not mount dead affordances: the launcher only
 * appears when `public` is true and the /demo slot picker only renders when
 * `booking` is true. `booking` reports whether an anonymous visitor can
 * actually complete a demo booking today — writes enabled and no account
 * allowlist narrowing them to verified, allowlisted users.
 *
 * Responses carry the same origin-checked CORS headers as the rest of the
 * /api/myra family so the marketing origin may read them cross-origin; other
 * origins get none.
 */
import { env } from "@lyrashield/config"
import { myraCorsHeaders, myraPreflight } from "../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

export function GET(request: Request): Response {
  return Response.json(
    {
      public: env.MYRA_PUBLIC_ENABLED === "1",
      booking: env.MYRA_WRITES_ENABLED === "1" && !env.MYRA_ALLOWED_EMAILS,
    },
    {
      headers: {
        ...myraCorsHeaders(request),
        // Marketing caches this probe per page load; keep it short-lived so a
        // flag flip shows up quickly, but cacheable at the edge.
        "Cache-Control": "public, max-age=60",
      },
    }
  )
}
