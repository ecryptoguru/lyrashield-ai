import { LyraShieldError, cancelScan, getScan, isNotModified } from "@lyrashield/sdk"
import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import { describeCliFailure } from "../failure.js"
import type { Output } from "../output.js"

/**
 * `lyrashield cancel <scanId>` — request cancellation of a queued/running
 * scan (POST /api/v1/scans/:id). Cancellation is terminal-state aware:
 * a 409 means the scan already reached a terminal state or finalization
 * started, so the command re-reads the scan and reports the truth —
 * exit 0 when it is already CANCELLED, otherwise exit 1 with the real status.
 */
export async function handleCancel(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, { string: ["idempotency-key"] })
  const [rawScanId] = parsed._
  const scanId = rawScanId !== undefined ? String(rawScanId) : ""
  if (!scanId.trim()) {
    output.error("usage: lyrashield cancel <scanId> [--idempotency-key <key>]", 2)
    return 2
  }

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()

  try {
    const res = await cancelScan(client, scanId, {
      workspaceId,
      ...(parsed["idempotency-key"] ? { idempotencyKey: parsed["idempotency-key"] } : {}),
    })
    output.result({ ...res, scanId: res.id, terminalStatus: res.status ?? "CANCELLED" })
    output.notice(
      `Cancellation recorded for scan ${res.id} — the worker stops it shortly. ` +
        `Confirm with: lyrashield status ${res.id}`
    )
    return 0
  } catch (err) {
    if (err instanceof LyraShieldError && err.status === 409) {
      // Terminal/finalizing conflict — report the scan's true state rather
      // than the bare conflict. Already CANCELLED means the goal is met.
      try {
        const scan = await getScan(client, scanId, { workspaceId })
        const status = isNotModified(scan) ? "CANCELLED" : scan.status
        if (status === "CANCELLED") {
          output.result({ id: scanId, scanId, terminalStatus: "CANCELLED" })
          output.notice(`Scan ${scanId} is already cancelled — nothing to do.`)
          return 0
        }
        output.error(
          `Scan ${scanId} cannot be cancelled — it is already ${status}. ` +
            `Inspect it with: lyrashield status ${scanId}`,
          1
        )
        return 1
      } catch (readErr) {
        const { message, exitCode } = describeCliFailure(readErr)
        output.error(
          `Scan ${scanId} conflicted (${err.message}); status re-read failed: ${message}`,
          exitCode
        )
        return exitCode
      }
    }
    const { message, exitCode } = describeCliFailure(err)
    output.error(message, exitCode)
    return exitCode
  }
}
