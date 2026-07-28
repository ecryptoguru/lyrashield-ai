import { redirect } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@lyrashield/ui"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function EvidencePage() {
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
      <h1 className="text-2xl font-bold tracking-tight">Evidence</h1>
      <p className="text-muted-foreground text-sm">Independently verified evidence and public verdict disclosure.</p>
      <Card>
        <CardHeader>
          <CardTitle>Evidence records</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Run a review to collect evidence records for your products.</p>
        </CardContent>
      </Card>
    </div>
  )
}
