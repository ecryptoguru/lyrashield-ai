import { redirect } from "next/navigation"

/**
 * Compatibility route. Reports now live under the Issues → Reports tab at
 * /dashboard/findings?tab=reports. This permanent redirect preserves the
 * `scanId` query parameter used by report-generation deep links.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ scanId?: string }>
}) {
  const { scanId } = await searchParams
  const target = scanId
    ? `/dashboard/findings?tab=reports&scanId=${encodeURIComponent(scanId)}`
    : "/dashboard/findings?tab=reports"
  redirect(target)
}
