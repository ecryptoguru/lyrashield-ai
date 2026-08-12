import { listPreferredAgents } from "@lyrashield/agent-registry"
import { env } from "@lyrashield/config"
import { Bot } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { AgentsGrid, type AgentCardData } from "./agents-grid"

function mapAgentsToCardData(): AgentCardData[] {
  return listPreferredAgents().map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
    docsSlug: agent.docsSlug,
    installStrategy: agent.installStrategy,
    locations: agent.locations.map((location) => ({
      scope: location.scope,
      path: location.path,
      sharedByConvention: location.sharedByConvention,
    })),
    pluginLocations: agent.pluginLocations?.map((location) => ({
      scope: location.scope,
      path: location.path,
      sharedByConvention: location.sharedByConvention,
    })),
    rulesFiles: [...agent.rulesFiles],
  }))
}

export default async function AgentsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader title="Coding Agents" description="Set up LyraShield in your coding agent." />
        <NoWorkspaceState
          icon={Bot}
          description="Create a workspace during onboarding to set up coding agents."
        />
      </div>
    )
  }

  const marketingUrl =
    (env.NEXT_PUBLIC_MARKETING_URL as string | undefined)?.replace(/\/+$/, "") ||
    "https://lyrashieldai.com"

  return (
    <div>
      <PageHeader
        title="Coding Agents"
        description="Install LyraShield in the coding agent your team uses."
      />
      <AgentsGrid agents={mapAgentsToCardData()} docsBaseUrl={`${marketingUrl}/docs/integrations`} />
    </div>
  )
}
