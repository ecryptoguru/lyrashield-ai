import type { listAgentConnections } from "@lyrashield/db"
import { Badge, Card, CardContent } from "@lyrashield/ui"
import { connectionHealth } from "@/lib/connection-health"
import { LocalTime } from "@/components/local-time"
import { ConnectionActions } from "./connection-actions"

type ConnectedClient = Pick<
  Awaited<ReturnType<typeof listAgentConnections>>[number],
  | "id"
  | "userId"
  | "clientName"
  | "clientType"
  | "scopes"
  | "status"
  | "createdAt"
  | "lastSuccessfulOperationAt"
  | "allTargets"
  | "expiresAt"
>

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

export function ConnectedClientCard({
  connection,
  workspaceId,
  userId,
}: {
  connection: ConnectedClient
  workspaceId: string
  userId: string
}) {
  const health = connectionHealth(connection)
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <p className="wrap-anywhere font-medium">
            {connection.clientName ?? connection.clientType}
          </p>
          <p className="text-muted-foreground mt-1 wrap-anywhere text-xs">
            {connection.scopes.length > 0
              ? `Scopes: ${connection.scopes.join(", ")}`
              : "No scopes granted"}
            {" · "}
            {health.usability}
            {" · "}
            Connected <LocalTime value={connection.createdAt} />
            {" · "}
            {connection.lastSuccessfulOperationAt ? (
              <>
                Last used <LocalTime value={connection.lastSuccessfulOperationAt} withTime />
              </>
            ) : (
              "No successful operation recorded"
            )}
            {connection.allTargets ? " · all current and future targets" : ""}
            {connection.expiresAt ? (
              <>
                {" · authorization expires "}
                <LocalTime value={connection.expiresAt} />
              </>
            ) : (
              ""
            )}
          </p>
        </div>
        <Badge variant={connectionStatusVariant(health.status)}>
          {health.status.replaceAll("_", " ").toLowerCase()}
        </Badge>
        {connection.userId === userId && (
          <ConnectionActions
            id={connection.id}
            workspaceId={workspaceId}
            status={health.status}
            clientName={connection.clientName ?? connection.clientType}
          />
        )}
      </CardContent>
    </Card>
  )
}
