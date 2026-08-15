import { permanentRedirect } from "next/navigation"

/**
 * Compatibility route. Automations now live under the Trust Runs → Monitoring tab
 * at /dashboard/scans?tab=monitoring. This permanent redirect preserves all
 * existing bookmarks and internal links.
 */
export default function AutomationsPage() {
  permanentRedirect("/dashboard/scans?tab=monitoring")
}
