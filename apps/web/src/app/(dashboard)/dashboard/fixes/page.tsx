import { permanentRedirect } from "next/navigation"

/**
 * Compatibility route (Deep Review v16 3.2). Proposed fixes are a Findings
 * view at /dashboard/findings?tab=fixes, not an independent destination —
 * the same fold that moved reports under /dashboard/reports (W2-10). The old
 * route forwards so existing links keep working.
 */
export default async function FixesRedirect() {
  permanentRedirect("/dashboard/findings?tab=fixes")
}
