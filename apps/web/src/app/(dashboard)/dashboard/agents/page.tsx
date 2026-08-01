import { listAgents } from "@lyrashield/agent-registry"
import { Puzzle } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { AgentsGrid, type AgentCardData } from "./agents-grid"

export const dynamic = "force-dynamic"

export default async function AgentsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent integrations</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Connect LyraShield to your coding agent so it can scan and apply approval-bound fixes.
          </p>
        </div>
        <NoWorkspaceState
          icon={Puzzle}
          description="Create a workspace during onboarding to manage agent plugins and skills."
        />
      </div>
    )
  }

  const raw = listAgents()
  const agents: AgentCardData[] = raw.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    docsSlug: a.docsSlug,
    installStrategy: a.installStrategy,
    locations: a.locations.map((l) => ({
      scope: l.scope,
      path: l.path,
      sharedByConvention: l.sharedByConvention,
    })),
    rulesFiles: [...a.rulesFiles],
  }))

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Agent integrations</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Connect LyraShield to your coding agent so it can scan and apply approval-bound fixes directly
          in your workflow.
        </p>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Rules and skills stay in sync with{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">lyrashield rules add</code> — it
          writes the right file for each agent (<span className="font-mono text-xs">CLAUDE.md</span>,{" "}
          <span className="font-mono text-xs">.cursor/rules/lyrashield.mdc</span>, etc.).
        </p>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground">
        <span className="font-medium text-foreground">How it works:</span> Install the integration with{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">npx lyrashield install &lt;agent-id&gt;</code>{" "}
        and then manage rules with{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">lyrashield rules add</code> /{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">remove</code>.
      </div>

      <AgentsGrid agents={agents} />
    </div>
  )
}
