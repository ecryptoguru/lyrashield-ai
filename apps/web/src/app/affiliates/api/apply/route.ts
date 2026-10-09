import { withCookieMutation } from "../../../../lib/api-auth"
import { NextResponse } from "next/server"
import { getCachedSession } from "@/lib/cache"

/**
 * Affiliate applications are not open yet.
 *
 * New affiliate admission is frozen for launch. The route stays in place and
 * keeps accepting the same POST shape because `/affiliates/api/apply` is part
 * of the published additive-only surface (docs/policies.md). It no longer
 * parses the form, runs fraud signals or creates an Affiliate row: it answers
 * with a "not open yet" response and writes nothing.
 *
 * Existing Affiliate rows are untouched. Historical commissions, refunds and
 * clawbacks keep running through the billing webhook affiliate track, which
 * this route never wrote to.
 *
 * The browser-session boundary is checked before the closed response so a
 * workspace API key or OAuth credential still cannot act on this route.
 */
async function post() {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 })
  }
  if (session.apiKey || session.oauth) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 })
  }

  return NextResponse.json(
    { success: false, error: "Affiliate applications are not open yet." },
    { status: 503, headers: { "Cache-Control": "private, no-store" } }
  )
}

export const POST = withCookieMutation(post)
