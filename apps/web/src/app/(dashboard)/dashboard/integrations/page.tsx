import { prisma } from "@lyrashield/db"
import { Plug } from "lucide-react"
import { GithubIntegration } from "./github-integration"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ github?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Integrations</h2>
          <p className="text-muted-foreground text-sm">
            Connect external services to your workspace.
          </p>
        </div>
        <NoWorkspaceState
          icon={Plug}
          description="Create a workspace during onboarding to manage integrations."
        />
      </div>
    )
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  })
  const workspaceName = workspace?.name ?? "your workspace"

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
