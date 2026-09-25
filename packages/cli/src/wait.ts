import process from "node:process"
import {
  LyraShieldError,
  getOperationStatus,
  waitForScan,
  type LyraShieldClient,
  type OperationStatus,
  type ScanSnapshot,
} from "@lyrashield/sdk"
import { describeCliFailure } from "./failure.js"
import type { Output } from "./output.js"

/** Watched work ended without success — scan terminal ≠ COMPLETED, or an operation FAILED/CONFLICT. */
export const EXIT_TERMINAL_UNSUCCESSFUL = 7
/** The wait deadline elapsed before a terminal state. */
export const EXIT_WAIT_TIMEOUT = 8
/** SIGINT while waiting — the server-side work keeps running. */
export const EXIT_SIGINT = 130

export const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_POLL_INTERVAL_MS = 5000

export interface WaitFlags {
  wait: boolean
  timeoutMs?: number
  pollIntervalMs?: number
}

/**
 * Parse --wait/--watch/--timeout/--poll-interval from a minimist result.
 * `--watch` is a pure alias of `--wait`. `--timeout` is seconds (1..86400);
 * `--poll-interval` is seconds (>=1, matching the SDK's 1s poll floor).
 * Returns null after emitting a usage error when the flags are invalid, so
 * callers can bail before creating targets or submitting scans.
 */
export function parseWaitFlags(parsed: Record<string, unknown>, output: Output): WaitFlags | null {
  const wait = parsed.wait === true || parsed.watch === true
  let timeoutMs: number | undefined
  let pollIntervalMs: number | undefined

  if (parsed.timeout !== undefined) {
    const seconds = Number(parsed.timeout)
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) {
      output.error("--timeout must be a number of seconds between 1 and 86400.", 2)
      return null
    }
    timeoutMs = Math.round(seconds * 1000)
  }
  if (parsed["poll-interval"] !== undefined) {
    const seconds = Number(parsed["poll-interval"])
    if (!Number.isFinite(seconds) || seconds < 1) {
      output.error("--poll-interval must be a number of seconds >= 1.", 2)
      return null
    }
    pollIntervalMs = Math.round(seconds * 1000)
    if (pollIntervalMs < 1000) {
      output.error("--poll-interval must be at least 1 second.", 2)
      return null
    }
  }
  if (!wait && (timeoutMs !== undefined || pollIntervalMs !== undefined)) {
    output.error("--timeout and --poll-interval only apply with --wait/--watch.", 2)
    return null
  }
  return { wait, timeoutMs, pollIntervalMs }
}

export interface WaitControl {
  signal: AbortSignal
  interrupted: () => boolean
  dispose: () => void
}

/**
 * AbortController bound to process SIGINT. Registering a listener suppresses
 * the default Ctrl+C termination, so the command can report resumable state
 * and exit 130 itself. Always dispose() when the wait ends.
 */
export function bindSigint(controller = new AbortController()): WaitControl {
  const onSigint = () => controller.abort()
  process.on("SIGINT", onSigint)
  return {
    signal: controller.signal,
    interrupted: () => controller.signal.aborted,
    dispose: () => process.removeListener("SIGINT", onSigint),
  }
}

/**
 * Wait progress goes to stderr in every mode: notice() already targets stderr
 * in human mode; in --json mode stdout must stay a single final document, so
 * progress is written to stderr directly (never NDJSON on stdout).
 */
export function emitWaitProgress(output: Output, message: string): void {
  if (output.json) {
    if (!output.quiet) process.stderr.write(`${message}\n`)
    return
  }
  output.notice(message)
}

function progressLine(snapshot: ScanSnapshot): string {
  const queuePosition = (snapshot as { queuePosition?: unknown }).queuePosition
  const queue =
    snapshot.status === "QUEUED" && typeof queuePosition === "number"
      ? ` (queue position ${queuePosition})`
      : ""
  return `scan ${snapshot.id}: ${snapshot.status}${queue}`
}

function reportScanTerminal(
  output: Output,
  scan: ScanSnapshot,
  operationId?: string
): { code: number; result: Record<string, unknown> } {
  const result = {
    ...scan,
    scanId: scan.id,
    terminalStatus: scan.status,
    ...(operationId ? { operationId } : {}),
    resumeCommand: `lyrashield status ${scan.id} --watch`,
  }
  output.result(result)
  return { code: scan.status === "COMPLETED" ? 0 : EXIT_TERMINAL_UNSUCCESSFUL, result }
}

function describeWaitFailure(err: unknown): { message: string; exitCode: number } {
  if (err instanceof LyraShieldError && err.code === "SCAN_WAIT_TIMEOUT") {
    return { message: err.message, exitCode: EXIT_WAIT_TIMEOUT }
  }
  return describeCliFailure(err)
}

/**
 * Wait on a scan to a terminal state, printing transitions to stderr.
 * Prints the final result (including terminalStatus, scanId, operationId when
 * known, and a resume command) and returns the exit code:
 *   0 COMPLETED · 7 other terminal · 8 deadline · 130 SIGINT.
 */
export async function runScanWait(
  client: LyraShieldClient,
  output: Output,
  params: {
    scanId: string
    workspaceId: string
    timeoutMs?: number
    pollIntervalMs?: number
    operationId?: string
  }
): Promise<number> {
  const control = bindSigint()
  try {
    const scan = await waitForScan(client, params.scanId, {
      workspaceId: params.workspaceId,
      signal: control.signal,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
      onProgress: (snapshot) => emitWaitProgress(output, progressLine(snapshot)),
    })
    return reportScanTerminal(output, scan, params.operationId).code
  } catch (err) {
    if (
      control.interrupted() ||
      (err instanceof LyraShieldError && err.code === "SCAN_WAIT_ABORTED")
    ) {
      output.error(
        `Interrupted — scan ${params.scanId} continues running on the server. ` +
          `Resume watching with: lyrashield status ${params.scanId} --watch ` +
          `— or cancel it with: lyrashield cancel ${params.scanId}`,
        EXIT_SIGINT
      )
      return EXIT_SIGINT
    }
    const { message, exitCode } = describeWaitFailure(err)
    output.error(message, exitCode)
    return exitCode
  } finally {
    control.dispose()
  }
}

/**
 * An internal scan reference from an operation result is a bare scan id
 * (cuid-shaped). Anything else — URLs, paths, empty strings — is not
 * followed: the operation result is reported without a scan tail.
 */
export function extractInternalScanId(resultLocation: string | null): string | null {
  if (!resultLocation) return null
  const trimmed = resultLocation.trim()
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null
}

function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Wait on a durable agent operation to COMPLETED/FAILED/CONFLICT, then — when
 * the operation produced an internal scan id — continue waiting on that scan
 * inside the remaining budget. Returns the CLI exit code.
 */
export async function runOperationWait(
  client: LyraShieldClient,
  output: Output,
  params: {
    operationId: string
    workspaceId: string
    timeoutMs?: number
    pollIntervalMs?: number
  }
): Promise<number> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const pollIntervalMs = Math.max(1000, params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const deadline = Date.now() + timeoutMs
  const control = bindSigint()
  const resumeCommand = `lyrashield status --operation ${params.operationId} --watch`
  let lastStatus: string | undefined
  try {
    for (;;) {
      const op: OperationStatus = await getOperationStatus(
        client,
        params.operationId,
        params.workspaceId,
        { signal: control.signal }
      )
      if (op.status !== lastStatus) {
        lastStatus = op.status
        emitWaitProgress(output, `operation ${params.operationId}: ${op.status}`)
      }

      if (op.status === "COMPLETED") {
        const scanId = extractInternalScanId(op.resultLocation)
        if (!scanId) {
          output.result({
            ...op,
            terminalStatus: op.status,
            operationId: op.operationId,
            resumeCommand,
            note: "Operation completed without a followable scan reference.",
          })
          return 0
        }
        emitWaitProgress(
          output,
          `operation ${params.operationId} produced scan ${scanId}; waiting on the scan`
        )
        return await runScanWait(client, output, {
          scanId,
          workspaceId: params.workspaceId,
          timeoutMs: Math.max(1, deadline - Date.now()),
          pollIntervalMs,
          operationId: params.operationId,
        })
      }

      if (op.status === "FAILED" || op.status === "CONFLICT") {
        const retryNote =
          op.recovery === "retry_new_key"
            ? " The submission was not recorded — safe to retry with a new idempotency key."
            : ""
        output.result({
          ...op,
          terminalStatus: op.status,
          operationId: op.operationId,
          resumeCommand,
        })
        emitWaitProgress(output, `operation ${params.operationId} ${op.status}.${retryNote}`)
        return EXIT_TERMINAL_UNSUCCESSFUL
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        output.error(
          `Operation ${params.operationId} is still ${lastStatus ?? "running"} after ` +
            `${Math.round(timeoutMs / 1000)}s. Resume with: ${resumeCommand}`,
          EXIT_WAIT_TIMEOUT
        )
        return EXIT_WAIT_TIMEOUT
      }
      await sleepMs(Math.min(pollIntervalMs, remaining), control.signal)
    }
  } catch (err) {
    if (
      control.interrupted() ||
      (err instanceof Error && err.name === "AbortError") ||
      (err instanceof LyraShieldError && err.code === "REQUEST_ABORTED")
    ) {
      output.error(
        `Interrupted — operation ${params.operationId} may still be running. ` +
          `Resume with: ${resumeCommand}`,
        EXIT_SIGINT
      )
      return EXIT_SIGINT
    }
    const { message, exitCode } = describeCliFailure(err)
    output.error(message, exitCode)
    return exitCode
  } finally {
    control.dispose()
  }
}

export type { ScanSnapshot }
