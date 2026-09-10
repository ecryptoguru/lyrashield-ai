import { connectionHealth } from "@/lib/connection-health"
import { ConnectionActions } from "./connection-actions"
import type { Metadata } from "next"
import Link from "next/link"
import { listAgentConnections } from "@lyrashield/db"
import { Bot, Plug } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@lyrashield/ui"

export const metadata: Metadata = {
  title: "Connections",
}

function connectionStatusVariant(status: string): "success" | "warning" | "danger" | "muted" {
  switch (status) {
    case "ACTIVE":
      return "success"
    case "PAUSED":
      return "warning"
    case "REVOKED":
    case "EXPIRED":
      return "danger"
    default:
      return "muted"
  }
}

/**
 * W2-08/W2-09: one Connections destination. Connected coding-agent clients
 * come first with health and recovery; the install catalog stays reachable
 * through the existing Coding Agents and Integrations destinations, whose
 * URLs keep working.
 */
export default async function ConnectionsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Connections"
          description="Connect coding agents, source control, and other services to your workspace."
        />
        <NoWorkspaceState
          icon={Bot}
          description="Create a workspace during onboarding to manage connections."
        />
      </div>
    )
  }

  const connections = await listAgentConnections(workspaceId)

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connected clients first, then the install catalog for coding agents, source control, and other services."
      />

      <section className="space-y-3" aria-labelledby="connected-heading">
        <h2 id="connected-connections" className="text-lg font-semibold tracking-tight">
          Connected clients
        </h2>
        {connections.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="text-muted-foreground p-6 text-sm">
              No coding-agent connections yet. Install LyraShield in your agent below, or connect
              through an OAuth consent from your client.
            </CardContent>
          </Card>
        ) : (
          <ul className="grid gap-2">
            {connections.map((connection) => {
              const health = connectionHealth(connection)
              return (
                <li key={connection.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {connection.clientName ?? connection.clientType}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {connection.scopes.length > 0
                            ? `Scopes: ${connection.scopes.join(", ")}`
                            : "No scopes granted"}
                          {" · "}
                          {health.usability}
                          {" · "}
                          Connected {new Date(connection.createdAt).toLocaleDateString()}
                          {" · "}
                          {connection.lastSuccessfulOperationAt
                            ? `Last used ${new Date(connection.lastSuccessfulOperationAt).toLocaleString()}`
                            : "No successful operation recorded"}
                          {connection.allTargets ? " · all current and future targets" : ""}
                          {connection.expiresAt
                            ? ` · authorization expires ${new Date(connection.expiresAt).toLocaleDateString()}`
                            : ""}
                        </p>
                      </div>
                      <Badge variant={connectionStatusVariant(health.status)}>
                        {health.status.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                      {connection.userId === session.userId && (
                        <ConnectionActions
                          id={connection.id}
                          workspaceId={workspaceId}
                          status={health.status}
                        />
                      )}
                    </CardContent>
                  </Card>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="mt-8 space-y-3" aria-labelledby="catalog-connections">
        <h2 id="catalog-connections" className="text-lg font-semibold tracking-tight">
          Install catalog
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Bot className="text-primary size-4" aria-hidden="true" />
                Coding agents
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">
                Install LyraShield in the coding agent your team uses.
              </p>
              <Link
                href="/dashboard/agents"
                className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-3" })}
              >
                Browse coding agents
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Plug className="text-primary size-4" aria-hidden="true" />
                Source control and other services
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Connect GitHub, MCP, and the CLI.</p>
              <Link
                href="/dashboard/integrations"
                className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-3" })}
              >
                Open Integrations
              </Link>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  )
}
