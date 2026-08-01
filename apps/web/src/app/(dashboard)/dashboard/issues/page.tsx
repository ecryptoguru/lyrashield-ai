import { permanentRedirect } from "next/navigation"

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ finding?: string }>
}) {
  const params = await searchParams
  const query = new URLSearchParams()
  if (params.finding) query.set("finding", params.finding)
  const search = query.toString()
  permanentRedirect(`/dashboard/findings${search ? `?${search}` : ""}`)
}
