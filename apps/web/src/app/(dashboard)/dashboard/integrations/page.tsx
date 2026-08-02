import { prisma } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import Link from "next/link"
import { Plug } from "lucide-react"
import { GithubIntegration } from "./github-integration"
import { McpIntegration } from "./mcp-integration"
import { CliIntegration } from "./cli-integration"
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
  const githubStatus = (await searchParams).github
  const githubVerificationRequired = githubStatus === "verification_required"
  const githubAlreadyClaimed = githubStatus === "already_claimed"

  const appOriginRaw = (env.NEXT_PUBLIC_APP_URL as string | undefined) ?? ""
  const appOrigin = appOriginRaw.replace(/\/+$/, "")
  const mcpEndpointUrl = appOrigin ? `${appOrigin}/api/mcp` : "/api/mcp"
  const marketingUrl =
    (env.NEXT_PUBLIC_MARKETING_URL as string | undefined)?.replace(/\/+$/, "") ??
    "https://lyrashield.ai"
  const docsUrl = `${marketingUrl}/docs/integrations`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-muted-foreground text-sm">
          Connect external services to your workspace ({workspaceName}).
        </p>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
          Three ways to plug in: <span className="text-foreground font-medium">GitHub</span> to scan
          repositories, the <span className="text-foreground font-medium">MCP server</span> to give
          your coding agent live evidence, or the{" "}
          <span className="text-foreground font-medium">CLI</span> to scan from your terminal or CI.
          Looking for per-agent setup? See{" "}
          <Link
            href="/dashboard/agents"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            Agent integrations
          </Link>
          .
        </p>
      </div>

      {githubVerificationRequired && (
        <div
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
          role="alert"
        >
          We could not confirm with GitHub that you administer this installation, so it was not
          connected. Start the install from the Connect button below — approving GitHub&apos;s
          authorization prompt is what proves ownership. If you cancelled that prompt, try again.
        </div>
      )}

      {githubAlreadyClaimed && (
        <div
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
          role="alert"
        >
          This GitHub installation is already connected to a different LyraShield workspace. An
          installation can only be linked to one workspace at a time — disconnect it there first, or
          install the app on a different GitHub account or organisation.
        </div>
      )}

      <GithubIntegration
        workspaceId={workspaceId}
        connected={!!githubIntegration}
        accountLogin={githubIntegration?.metadata as { accountLogin?: string } | null}
      />

      <McpIntegration endpointUrl={mcpEndpointUrl} docsUrl={docsUrl} />

      <CliIntegration docsUrl={docsUrl} />
    </div>
  )
}
