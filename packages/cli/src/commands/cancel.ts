import { cancelScan } from "@lyrashield/sdk"
import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

/** Explicit cancellation is separate from stopping a local wait. */
export async function handleCancel(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { string: ["idempotency-key"] })
  const [scanId] = parsed._ as string[]
  if (!scanId || parsed._.length !== 1) {
    output.error("usage: lyrashield cancel <scanId> [--idempotency-key <key>]")
    return 2
  }
  if (parsed["idempotency-key"] !== undefined && !parsed["idempotency-key"].trim()) {
    output.error("--idempotency-key must be non-empty")
    return 2
  }
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  // The server owns cancellation and rejects terminal/finalizing scans with 409.
  // The request key is accepted for caller traceability; the endpoint's state
  // transition is the source of truth for retries.
  const result = parsed["idempotency-key"]
    ? await client.request("POST", `/scans/${encodeURIComponent(scanId)}`, {
        body: { workspaceId },
        headers: { "Idempotency-Key": parsed["idempotency-key"] },
      })
    : await cancelScan(client, scanId, workspaceId)
  output.result(result)
  return 0
}
