import { redirect } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@lyrashield/ui"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function ApprovalsPage() {
  const session = await getCachedSession()
  if (!session) {
    redirect("/sign-in")
  }

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    redirect("/onboarding")
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Approval Centre</h1>
      <p className="text-muted-foreground text-sm">Review and approve remediation actions before they are applied.</p>
      <Card>
        <CardHeader>
          <CardTitle>Pending approvals</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">No approvals pending. This surface will be populated as the V2 rollout continues.</p>
        </CardContent>
      </Card>
    </div>
  )
}
