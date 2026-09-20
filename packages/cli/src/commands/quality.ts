import { getScanQuality } from "@lyrashield/sdk"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

/**
 * `lyrashield quality <scanId>` — the scan's truthful quality surface:
 * measured facts from stored evidence, labeled heuristics, and the
 * per-surface parity table. Read-only; raw passthrough like `status`.
 */
export async function handleQuality(args: string[], output: Output): Promise<number> {
  const [scanId] = args
  if (!scanId) {
    output.error("Usage: lyrashield quality <scanId>")
    return 2
  }
  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  const res = await getScanQuality(client, scanId, workspaceId)
  output.result(res)
  return 0
}
