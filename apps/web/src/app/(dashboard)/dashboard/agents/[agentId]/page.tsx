import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { env } from "@lyrashield/config"
import { listAgents } from "@lyrashield/agent-registry"
import { ArrowLeft, Puzzle } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { buildAgentWizard } from "@/lib/agent-wizard"
import { AgentWizard } from "./agent-wizard"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Agent integration | LyraShield AI",
  description: "Set up and verify an agent integration for your workspace.",
  openGraph: {
    title: "Agent integration | LyraShield AI",
    description: "Set up and verify an agent integration for your workspace.",
    type: "website",
    siteName: "LyraShield AI",
  },
}

export default async function AgentWizardPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  const agent = listAgents().find((a) => a.id === agentId)
  if (!agent) notFound()

  const appOrigin = ((env.NEXT_PUBLIC_APP_URL as string | undefined) ?? "").replace(/\/+$/, "")
  const mcpEndpointUrl = appOrigin ? `${appOrigin}/api/mcp` : "/api/mcp"
  const marketingUrl =
    (env.NEXT_PUBLIC_MARKETING_URL as string | undefined)?.replace(/\/+$/, "") ||
    "https://lyrashieldai.com"
  const docsUrl = `${marketingUrl}/docs/integrations/${agent.docsSlug}`

  const data = buildAgentWizard(agent.id, mcpEndpointUrl)
  if (!data) notFound()

  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <BackLink />
        <h2 className="text-2xl font-bold tracking-tight">Set up {data.displayName}</h2>
        <NoWorkspaceState
          icon={Puzzle}
          description="Create a workspace during onboarding to set up agent integrations."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Set up {data.displayName}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm leading-6">
          Follow the steps to connect {data.displayName} to LyraShield — install the integration,
          add your API key, sync rules, and verify. Everything uses the real CLI commands, so you
          can paste them into your terminal.
        </p>
      </div>

      <AgentWizard data={data} docsUrl={docsUrl} />
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/dashboard/integrations?tab=agents"
      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1.5 text-sm font-medium"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      All agent integrations
    </Link>
  )
}
