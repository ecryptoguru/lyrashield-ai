import { permanentRedirect } from "next/navigation"

/**
 * Compatibility route (W2-10). Reports are a direct destination at
 * /dashboard/reports; the old findings reports tab keeps working by
 * forwarding its `scanId` and `targetId` query scope.
 */
export default async function FindingsReportsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ finding?: string; scanId?: string; targetId?: string }>
}) {
  const params = await searchParams
  const query = new URLSearchParams()
  if (params.scanId) query.set("scanId", params.scanId)
  if (params.targetId) query.set("targetId", params.targetId)
  const search = query.toString()
  permanentRedirect(`/dashboard/reports${search ? `?${search}` : ""}`)
}
