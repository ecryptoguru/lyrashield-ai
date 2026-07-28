import { redirect } from "next/navigation"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCachedSession()
  if (!session) {
    redirect("/sign-in")
  }

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    redirect("/onboarding")
  }

  const { id } = await params
  redirect(`/dashboard/scans/${id}`)
}
