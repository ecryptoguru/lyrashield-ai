import { permanentRedirect } from "next/navigation"

/**
 * Compatibility route. Schedules now live under the Scans → Monitoring tab
 * at /dashboard/scans?tab=monitoring. This permanent redirect preserves all
 * existing bookmarks and internal links.
 */
export default function SchedulesPage() {
  permanentRedirect("/dashboard/scans?tab=monitoring")
}
