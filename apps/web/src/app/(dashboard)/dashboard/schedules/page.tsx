import { redirect } from "next/navigation"

/**
 * Compatibility route. Schedules now live under the Trust Runs → Monitoring tab
 * at /dashboard/scans?tab=monitoring. This permanent redirect preserves all
 * existing bookmarks and internal links.
 */
export default function SchedulesPage() {
  redirect("/dashboard/scans?tab=monitoring")
}
