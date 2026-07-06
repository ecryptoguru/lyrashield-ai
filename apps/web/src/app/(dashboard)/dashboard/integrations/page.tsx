import { prisma } from "@lyrashield/db"
import { notFound } from "next/navigation"
import { GithubIntegration } from "./github-integration"
import { getCachedSession, getCachedWorkspaces } from "@/lib/cache"

export default async function IntegrationsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaces = await getCachedWorkspaces(session.userId)

  if (workspaces.length === 0) {
    notFound()
  }

  const firstWorkspace = workspaces[0]
  if (!firstWorkspace) return null

  const workspaceId = firstWorkspace.id
  const workspaceName = firstWorkspace.name

  const integrations = await prisma.integration.findMany({
    where: { workspaceId, deletedAt: null },
  })

  const githubIntegration = integrations.find((i) => i.type === "GITHUB")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect external services to your workspace ({workspaceName}).
        </p>
      </div>

      <GithubIntegration
        workspaceId={workspaceId}
        connected={!!githubIntegration}
        accountLogin={
          githubIntegration?.metadata as { accountLogin?: string } | null
        }
      />
    </div>
  )
}
