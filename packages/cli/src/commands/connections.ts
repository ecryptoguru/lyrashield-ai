import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleConnections(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["json", "help"],
    string: ["workspace"],
    alias: { w: "workspace", h: "help" },
  })

  const [subcommand, connectionId] = parsed._

  if (parsed.help || !subcommand) {
    output.log(`Usage: lyrashield connections <subcommand> [options]

Manage delegated agent connections.

Subcommands:
  list                      List agent connections for active workspace
  pause <id>                Pause an active connection
  resume <id>               Resume a paused connection
  disconnect <id>           Revoke and disconnect an agent connection
  revoke <id>               Alias for disconnect

Options:
  --workspace, -w <id>      Target workspace ID
  --json                    Output results as JSON
  --help, -h                Show this help message`)
    return 0
  }

  const creds = await getEffectiveCredentials()
  const workspaceId = parsed.workspace || creds.workspaceId

  if (!workspaceId) {
    output.error(
      "No workspace specified. Use --workspace <id> or set default workspace with: lyrashield use <id>"
    )
    return 2
  }

  const client = await createClient()

  switch (subcommand) {
    case "list": {
      try {
        const res = (await client.request(
          "GET",
          `/connections?workspaceId=${encodeURIComponent(workspaceId)}`
        )) as {
          success?: boolean
          data?: Array<{
            id: string
            clientType: string
            clientName: string | null
            status: string
            allowedOperations: string[]
            allowedTargetIds: string[]
            createdAt: string
          }>
        }
        const connections = res.data ?? (Array.isArray(res) ? res : [])

        if (output.json) {
          output.result({ connections })
        } else {
          if (connections.length === 0) {
            output.log("No connections found for this workspace.")
          } else {
            output.log(`Connections for workspace ${workspaceId}:`)
            for (const conn of connections) {
              const ops =
                conn.allowedOperations.length > 0 ? conn.allowedOperations.join(", ") : "read-only"
              output.log(
                `  • ${conn.id} [${conn.status}] ${conn.clientName || conn.clientType} (${ops})`
              )
            }
          }
        }
        return 0
      } catch (err) {
        output.error(
          `Failed to list connections: ${err instanceof Error ? err.message : String(err)}`
        )
        return 1
      }
    }

    case "pause": {
      if (!connectionId) {
        output.error("usage: lyrashield connections pause <connectionId>")
        return 2
      }
      try {
        const res = await client.request(
          "POST",
          `/connections/${encodeURIComponent(connectionId)}/pause`,
          {
            body: { workspaceId },
          }
        )
        if (output.json) {
          output.result(res)
        } else {
          output.log(`✓ Connection ${connectionId} paused.`)
        }
        return 0
      } catch (err) {
        output.error(
          `Failed to pause connection: ${err instanceof Error ? err.message : String(err)}`
        )
        return 1
      }
    }

    case "resume": {
      if (!connectionId) {
        output.error("usage: lyrashield connections resume <connectionId>")
        return 2
      }
      try {
        const res = await client.request(
          "POST",
          `/connections/${encodeURIComponent(connectionId)}/resume`,
          {
            body: { workspaceId },
          }
        )
        if (output.json) {
          output.result(res)
        } else {
          output.log(`✓ Connection ${connectionId} resumed.`)
        }
        return 0
      } catch (err) {
        output.error(
          `Failed to resume connection: ${err instanceof Error ? err.message : String(err)}`
        )
        return 1
      }
    }

    case "disconnect":
    case "revoke": {
      if (!connectionId) {
        output.error("usage: lyrashield connections disconnect <connectionId>")
        return 2
      }
      try {
        const res = await client.request(
          "POST",
          `/connections/${encodeURIComponent(connectionId)}/revoke`,
          {
            body: { workspaceId },
          }
        )
        if (output.json) {
          output.result(res)
        } else {
          output.log(`✓ Connection ${connectionId} revoked and disconnected.`)
        }
        return 0
      } catch (err) {
        output.error(
          `Failed to disconnect connection: ${err instanceof Error ? err.message : String(err)}`
        )
        return 1
      }
    }

    default: {
      output.error(
        `Unknown subcommand '${subcommand}'. Run 'lyrashield connections --help' for usage.`
      )
      return 2
    }
  }
}
