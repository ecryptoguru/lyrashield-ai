import type { Metadata } from "next"
import {
  CLI_PACKAGE_VERSION,
  getPublishedCliInstallCommand,
  listPreferredAgents,
} from "@lyrashield/agent-registry"
import { env } from "@lyrashield/config"
import { Bot } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { AgentsGrid, type AgentCardData } from "./agents-grid"

function mapAgentsToCardData(): AgentCardData[] {
  return listPreferredAgents().map((agent) => ({
    id: agent.id,
    aliases: agent.aliases,
    displayName: agent.displayName,
    productFamily: agent.productFamily,
    docsSlug: agent.docsSlug,
    surface: agent.surface,
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
    skillLocations: agent.skillLocations?.map((location) => ({
      scope: location.scope,
      path: location.path,
      sharedByConvention: location.sharedByConvention,
    })),
    nativeCapabilities: [...(agent.nativeCapabilities ?? [])],
    rulesFiles: [...agent.rulesFiles],
    manualInstructions: agent.manualInstructions,
    installCommand: getPublishedCliInstallCommand(agent),
  }))
}

export const metadata: Metadata = {
  title: "Coding Agents",
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
      <AgentsGrid
        agents={mapAgentsToCardData()}
        docsBaseUrl={`${marketingUrl}/docs/integrations`}
        publishedCliVersion={CLI_PACKAGE_VERSION}
      />
    </div>
  )
}
