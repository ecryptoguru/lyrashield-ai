import { permanentRedirect } from "next/navigation"

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>
}) {
  const params = await searchParams
  const query = new URLSearchParams()
  if (params.new) query.set("new", params.new)
  const search = query.toString()
  permanentRedirect(`/dashboard/scans${search ? `?${search}` : ""}`)
}
