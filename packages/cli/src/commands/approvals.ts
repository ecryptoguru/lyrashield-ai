import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import {
  listAgentApprovals,
  createAgentApproval,
  approveAgentApproval,
  denyAgentApproval,
} from "@lyrashield/sdk"

export async function handleApprovals(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["action", "input", "id"],
    boolean: ["help"],
    alias: { a: "action", i: "input", h: "help" },
    default: { help: false },
  })

  if (parsed.help || !parsed._.length) {
    output.notice(usage())
    return 0
  }

  const [subcommand, id] = parsed._ as string[]
  const client = await createClient()
  const workspaceId = requireWorkspace(await getEffectiveCredentials())

  switch (subcommand) {
    case "list": {
      const status = (parsed.status as string | undefined) ?? undefined
      const res = await listAgentApprovals(client, { workspaceId, ...(status ? { status: status as never } : {}) })
      output.result(res)
      return 0
    }
    case "create": {
      const action = (parsed.action as string | undefined) ?? id
      if (!action) {
        output.error("Usage: lyrashield approvals create <actionName> --input '{...}'")
        return 2
      }
      const input = parsed.input ? (JSON.parse(parsed.input as string) as Record<string, unknown>) : {}
      const res = await createAgentApproval(client, { workspaceId, actionName: action, input })
      output.result(res)
      return 0
    }
    case "approve": {
      if (!id) {
        output.error("Usage: lyrashield approvals approve <approvalId> --input '{...}'")
        return 2
      }
      const input = parsed.input ? (JSON.parse(parsed.input as string) as Record<string, unknown>) : {}
      const res = await approveAgentApproval(client, id, { workspaceId, input })
      output.result(res)
      return 0
    }
    case "deny": {
      if (!id) {
        output.error("Usage: lyrashield approvals deny <approvalId>")
        return 2
      }
      const res = await denyAgentApproval(client, id, workspaceId)
      output.result(res)
      return 0
    }
    default:
      output.error(`Unknown approvals subcommand: ${subcommand}`)
      output.notice(usage())
      return 2
  }
}

function usage(): string {
  return `lyrashield approvals <subcommand>

Subcommands:
  list                      List agent approvals
  create <actionName>       Create a new approval
  approve <approvalId>      Approve a pending action
  deny <approvalId>         Deny a pending action

Options:
  --status <PENDING|...>    Filter list by status
  --input '{"key":"val"}'   JSON input for create/approve`
}
