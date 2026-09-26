import { getOperationStatus } from "@lyrashield/sdk"
import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import { parseWaitFlags, runOperationWait, runScanWait } from "../wait.js"

export async function handleStatus(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["watch", "wait"],
    string: ["operation", "timeout", "poll-interval"],
  })
  const [rawScanId] = parsed._
  const scanId = rawScanId !== undefined ? String(rawScanId) : undefined
  if (parsed.operation && scanId) {
    output.error("Supply a scan ID or --operation, not both.")
    return 2
  }

  const waitFlags = parseWaitFlags(parsed, output)
  if (!waitFlags) return 2
  if (waitFlags.wait && !parsed.operation && !scanId) {
    output.error("--watch needs a scan ID or --operation to follow.", 2)
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  if (parsed.operation) {
    if (waitFlags.wait) {
      return runOperationWait(client, output, {
        operationId: parsed.operation,
        workspaceId,
        ...(waitFlags.timeoutMs !== undefined ? { timeoutMs: waitFlags.timeoutMs } : {}),
        ...(waitFlags.pollIntervalMs !== undefined
          ? { pollIntervalMs: waitFlags.pollIntervalMs }
          : {}),
      })
    }
    const res = await getOperationStatus(client, parsed.operation, workspaceId)
    output.result(res)
    return 0
  }
  if (scanId) {
    if (waitFlags.wait) {
      return runScanWait(client, output, {
        scanId,
        workspaceId,
        ...(waitFlags.timeoutMs !== undefined ? { timeoutMs: waitFlags.timeoutMs } : {}),
        ...(waitFlags.pollIntervalMs !== undefined
          ? { pollIntervalMs: waitFlags.pollIntervalMs }
          : {}),
      })
    }
    const res = await client.request(
      "GET",
      `/scans/${encodeURIComponent(scanId)}?workspaceId=${encodeURIComponent(workspaceId)}`
    )
    output.result(res)
    return 0
  }

  const res = await client.request("GET", `/scans?workspaceId=${encodeURIComponent(workspaceId)}`)
  output.result(res)
  return 0
}
