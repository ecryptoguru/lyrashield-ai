import { permanentRedirect } from "next/navigation"

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>
}) {
  const params = await searchParams
  const query = new URLSearchParams()
  if (params.projectId) query.set("projectId", params.projectId)
  const search = query.toString()
  permanentRedirect(`/dashboard/targets${search ? `?${search}` : ""}`)
}
