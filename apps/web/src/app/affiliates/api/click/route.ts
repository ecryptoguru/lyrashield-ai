import { NextResponse, type NextRequest } from "next/server"

/**
 * Async click capture endpoint — closed.
 *
 * New affiliate admission is frozen for launch, so no Click row is created, no
 * AttributionToken is issued and no __ls_aff cookie is set. The route keeps its
 * path and POST method because `/affiliates/api/click` is part of the published
 * additive-only surface (docs/policies.md), and it answers a JSON body so the
 * calling script never sees a parse error.
 *
 * Existing Click and AttributionToken rows are untouched. Attribution that
 * already resolved keeps working through the commission engine, which reads the
 * persisted rows rather than this route.
 */
export async function POST(_request: NextRequest) {
  return NextResponse.json({ success: false, closed: true })
}
