import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { notFound } from "next/navigation"
import { GithubIntegration } from "./github-integration"

export default async function IntegrationsPage() {
  const session = await getSession()
  if (!session) return null

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    include: { workspace: true },
  })

  if (memberships.length === 0) {
    notFound()
  }

  const firstMembership = memberships[0]
  if (!firstMembership) return null

  const workspaceId = firstMembership.workspaceId
  const workspaceName = firstMembership.workspace.name

  const integrations = await prisma.integration.findMany({
    where: { workspaceId, deletedAt: null },
  })

  const githubIntegration = integrations.find((i) => i.type === "GITHUB")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Integrations</h1>
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
