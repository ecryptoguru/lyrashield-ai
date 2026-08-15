import { permanentRedirect } from "next/navigation"

/**
 * Compatibility route. Reports now live under the Issues → Reports tab at
 * /dashboard/findings?tab=reports. This permanent redirect preserves the
 * `scanId` query parameter used by report-generation deep links.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ scanId?: string; targetId?: string }>
}) {
  const { scanId, targetId } = await searchParams
  const query = new URLSearchParams({ tab: "reports" })
  if (scanId) query.set("scanId", scanId)
  if (targetId) query.set("targetId", targetId)
  permanentRedirect(`/dashboard/findings?${query.toString()}`)
}
