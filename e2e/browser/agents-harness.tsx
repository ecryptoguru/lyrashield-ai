import {
  CLI_PACKAGE_VERSION,
  getPublishedCliInstallCommand,
  listPreferredAgents,
} from "../../packages/agent-registry/src/index"
import { buildAgentWizard } from "../../apps/web/src/lib/agent-wizard"
import {
  AgentsGrid,
  type AgentCardData,
} from "../../apps/web/src/app/(dashboard)/dashboard/agents/agents-grid"
import { AgentWizard } from "../../apps/web/src/app/(dashboard)/dashboard/agents/[agentId]/agent-wizard"

function mapAgents(): AgentCardData[] {
  return listPreferredAgents().map((agent) => ({
    id: agent.id,
    aliases: agent.aliases,
    displayName: agent.displayName,
    productFamily: agent.productFamily,
    docsSlug: agent.docsSlug,
    surface: agent.surface,
    installStrategy: agent.installStrategy,
    locations: agent.locations,
    pluginLocations: agent.pluginLocations,
    skillLocations: agent.skillLocations,
    nativeCapabilities: agent.nativeCapabilities,
    rulesFiles: [...agent.rulesFiles],
    manualInstructions: agent.manualInstructions,
    installCommand: getPublishedCliInstallCommand(agent),
  }))
}

function copyRaceAgents(): AgentCardData[] {
  const productFamily = { id: "copy-race", name: "Copy Race" }
  return [
    {
      id: "copy-race-ide",
      displayName: "Copy Race IDE",
      productFamily,
      docsSlug: "copy-race-ide",
      surface: "ide",
      installStrategy: "guided-manual",
      locations: [],
      rulesFiles: [],
      installCommand: "lyrashield install copy-race-ide",
    },
    {
      id: "copy-race-cli",
      displayName: "Copy Race CLI",
      productFamily,
      docsSlug: "copy-race-cli",
      surface: "cli",
      installStrategy: "guided-manual",
      locations: [],
      rulesFiles: [],
      installCommand: "lyrashield install copy-race-cli",
    },
  ]
}

export function AgentsHarness() {
  const agents =
    new URLSearchParams(location.search).get("agents") === "copy-race"
      ? copyRaceAgents()
      : mapAgents()

  return (
    <main className="space-y-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">Coding Agents</h1>
      <AgentsGrid
        agents={agents}
        docsBaseUrl="https://lyrashieldai.com/docs/integrations"
        publishedCliVersion={CLI_PACKAGE_VERSION}
      />
    </main>
  )
}

export function AgentWizardHarness({ agentId }: { agentId: string }) {
  const data = buildAgentWizard(agentId, "https://app.lyrashieldai.com")
  if (!data) return <p role="alert">Unknown agent: {agentId}</p>
  return (
    <main className="space-y-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">Set up {data.displayName}</h1>
      <AgentWizard
        data={data}
        docsUrl={`https://lyrashieldai.com/docs/integrations/${data.docsSlug}`}
      />
    </main>
  )
}
