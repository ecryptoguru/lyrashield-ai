import { redirect } from "next/navigation"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function ProductsRedirectPage() {
  const session = await getCachedSession()
  if (!session) {
    redirect("/sign-in")
  }

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    redirect("/onboarding")
  }

  redirect("/dashboard/targets")
}
