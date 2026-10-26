import { getWorkspaceMembership } from "@lyrashield/auth/server"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
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

  const membership = await getWorkspaceMembership(workspaceId, session.userId)
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

  return (
    <div>
      <PageHeader title="Integrations" description="Connect external services to your workspace." />

      <div className="space-y-6">
        <GithubIntegration
          workspaceId={workspaceId}
          githubStatus={params.github}
          canManage={!!membership && hasPermission(membership.role, PERMISSIONS.integration.manage)}
          connected={!!githubIntegration}
          accountLogin={githubIntegration?.metadata as { accountLogin?: string } | null}
        />

        <McpIntegration endpointUrl={mcpEndpointUrl} docsUrl={docsUrl} />

        <CliIntegration docsUrl={docsUrl} />
      </div>
    </div>
  )
}
