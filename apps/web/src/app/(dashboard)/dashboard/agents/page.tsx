import { listAgents } from "@lyrashield/agent-registry"
import { env } from "@lyrashield/config"
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
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-6">
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

  // The integration guides live on the marketing site, not the app domain, so
  // the cards link out with an absolute URL (same pattern as the Integrations
  // page). A relative /docs/... path would 404 inside the app.
  const marketingUrl =
    (env.NEXT_PUBLIC_MARKETING_URL as string | undefined)?.replace(/\/+$/, "") ??
    "https://lyrashield.ai"
  const docsBaseUrl = `${marketingUrl}/docs/integrations`

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Agent integrations</h1>
        <p className="text-muted-foreground max-w-3xl text-sm leading-6">
          Connect LyraShield to your coding agent so it can scan and apply approval-bound fixes
          directly in your workflow.
        </p>
        <p className="text-muted-foreground max-w-3xl text-sm leading-6">
          Rules and skills stay in sync with{" "}
          <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
            lyrashield rules add
          </code>{" "}
          — it writes the right file for each agent (
          <span className="font-mono text-xs">CLAUDE.md</span>,{" "}
          <span className="font-mono text-xs">.cursor/rules/lyrashield.mdc</span>, etc.).
        </p>
      </div>

      <div className="bg-muted/30 text-muted-foreground rounded-lg border p-4 text-sm leading-6">
        <span className="text-foreground font-medium">How it works:</span> Install the integration
        with{" "}
        <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
          npx lyrashield install &lt;agent-id&gt;
        </code>{" "}
        and then manage rules with{" "}
        <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
          lyrashield rules add
        </code>{" "}
        / <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">remove</code>.
      </div>

      <AgentsGrid agents={agents} docsBaseUrl={docsBaseUrl} />
    </div>
  )
}
