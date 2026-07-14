import { prisma } from "@lyrashield/db"
import { notFound } from "next/navigation"
import { GithubIntegration } from "./github-integration"
import { getCachedSession, getCachedWorkspaces } from "@/lib/cache"

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ github?: string }>
}) {
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
  const githubVerificationRequired = (await searchParams).github === "verification_required"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-muted-foreground text-sm">
          Connect external services to your workspace ({workspaceName}).
        </p>
      </div>

      {githubVerificationRequired && (
        <div
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
          role="alert"
        >
          GitHub did not provide enough information to verify this installation for your workspace.
          It was not connected. Reopen the installation from this workspace after the GitHub
          ownership verification flow is available.
        </div>
      )}

      <GithubIntegration
        workspaceId={workspaceId}
        connected={!!githubIntegration}
        accountLogin={githubIntegration?.metadata as { accountLogin?: string } | null}
      />
    </div>
  )
}
