import type { Metadata } from "next"
import { prisma } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import { Plug } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { GithubIntegration } from "./github-integration"
import { McpIntegration } from "./mcp-integration"
import { CliIntegration } from "./cli-integration"

export const metadata: Metadata = {
  title: "Integrations",
}

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
      <div>
        <PageHeader
          title="Integrations"
          description="Connect external services to your workspace."
        />
        <NoWorkspaceState
          icon={Plug}
          description="Create a workspace during onboarding to manage integrations."
        />
      </div>
    )
  }

  const params = await searchParams
  const appOriginRaw = (env.NEXT_PUBLIC_APP_URL as string | undefined) ?? ""
  const appOrigin = appOriginRaw.replace(/\/+$/, "")
  const apiUrl = appOrigin
  const mcpEndpointUrl = `${apiUrl}/api/mcp`
  const marketingUrl =
    (env.NEXT_PUBLIC_MARKETING_URL as string | undefined)?.replace(/\/+$/, "") ||
    "https://lyrashieldai.com"
  const docsUrl = `${marketingUrl}/docs/integrations`

  const integrations = await prisma.integration.findMany({
    where: { workspaceId, deletedAt: null },
  })
  const githubIntegration = integrations.find((i) => i.type === "GITHUB")
  const githubStatus = params.github
  const githubVerificationRequired = githubStatus === "verification_required"
  const githubAlreadyClaimed = githubStatus === "already_claimed"

  return (
    <div>
      <PageHeader title="Integrations" description="Connect external services to your workspace." />

      {githubVerificationRequired && (
        <div
          className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
          role="alert"
        >
          We could not confirm with GitHub that you administer this installation, so it was not
          connected. Start the install from the Connect button below — approving GitHub&apos;s
          authorization prompt is what proves ownership. If you cancelled that prompt, try again.
        </div>
      )}

      {githubAlreadyClaimed && (
        <div
          className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
          role="alert"
        >
          This GitHub installation is already connected to a different LyraShield workspace. An
          installation can only be linked to one workspace at a time — disconnect it there first, or
          install the app on a different GitHub account or organisation.
        </div>
      )}

      <div className="space-y-6">
        <GithubIntegration
          workspaceId={workspaceId}
          connected={!!githubIntegration}
          accountLogin={githubIntegration?.metadata as { accountLogin?: string } | null}
        />

        <McpIntegration endpointUrl={mcpEndpointUrl} docsUrl={docsUrl} />

        <CliIntegration docsUrl={docsUrl} />
      </div>
    </div>
  )
}
