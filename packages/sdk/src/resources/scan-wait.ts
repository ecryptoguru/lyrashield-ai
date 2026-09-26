import { z } from "zod"
import type { LyraShieldClient } from "../client"
import { LyraShieldError, isNotModified } from "../errors"
import type { ScanSchema } from "../schemas"
import { getScan } from "./scans"

export type ScanSnapshot = z.infer<typeof ScanSchema>

/**
 * Local wire copy of the authoritative lifecycle in
 * packages/db/src/scan-transitions.ts — the published SDK cannot depend on
 * the private db package. The regression test in src/__tests__/scan-wait.test.ts
 * pins the exact server sets so a new server-side status fails loudly there
 * instead of spinning forever in a wait loop or becoming a false success.
 */
export const TERMINAL_SCAN_STATUSES: readonly string[] = Object.freeze([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])

/**
 * Every scan status the wait loop understands — nonterminal plus terminal.
 * An unrecognized status is treated as nonterminal (the wait continues until
 * the deadline); this list exists so callers can classify for display.
 */
export const KNOWN_SCAN_STATUSES: readonly string[] = Object.freeze([
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "REQUIRES_APPROVAL",
  ...TERMINAL_SCAN_STATUSES,
])

const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 5000
const MIN_POLL_INTERVAL_MS = 1000

export interface WaitForScanOptions {
  workspaceId?: string
  signal?: AbortSignal
  /** Overall wait deadline. Default 30 minutes; must be > 0. */
  timeoutMs?: number
  /** Delay between polls. Default 5s; minimum 1s — tighter polling is refused. */
  pollIntervalMs?: number
  /**
   * Called with each snapshot whose observable state changed versus the
   * previously emitted one (status, updatedAt, queue/progress fields), and on
   * the first snapshot.
   */
  onProgress?: (scan: ScanSnapshot) => void
}

function waitAbortError(scanId: string): LyraShieldError {
  return new LyraShieldError({
    status: 0,
    code: "SCAN_WAIT_ABORTED",
    message: `Stopped waiting for scan ${scanId}; the scan continues running on the server. Resume with: lyrashield status ${scanId} --watch`,
  })
}

function waitTimeoutError(scanId: string, timeoutMs: number): LyraShieldError {
  return new LyraShieldError({
    status: 0,
    code: "SCAN_WAIT_TIMEOUT",
    message: `Scan ${scanId} did not reach a terminal state within ${Math.round(timeoutMs / 1000)}s. It keeps running — resume with: lyrashield status ${scanId} --watch`,
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Change fingerprint for onProgress deduplication. Covers the status/updatedAt
 * pair plus the progress-bearing fields the scan-detail response carries when
 * present (queue position, event window, coverage receipts). Passthrough-only
 * fields that are missing simply do not participate.
 */
function snapshotFingerprint(scan: ScanSnapshot): string {
  const extra = scan as Record<string, unknown>
  return JSON.stringify({
    status: scan.status,
    updatedAt: scan.updatedAt ?? null,
    queuePosition: typeof extra.queuePosition === "number" ? extra.queuePosition : null,
    events: Array.isArray(extra.events) ? extra.events.length : null,
    coverageReceipts: Array.isArray(extra.coverageReceipts) ? extra.coverageReceipts.length : null,
  })
}

/**
 * Bounded single-consumer wait on a scan's terminal state. Polls
 * GET /scans/:id via {@link getScan} — the client's own 429/503 retry layer
 * applies per request, and a server Retry-After that outlasts it becomes the
 * delay before the next poll (never a second internal retry layer).
 *
 * Resolves with the final snapshot for EVERY terminal status — COMPLETED,
 * PARTIAL, FAILED, CANCELLED, STOPPED_BUDGET, TIMED_OUT — and leaves exit
 * behavior to the caller. Never resubmits, never cancels.
 *
 * Errors: `SCAN_WAIT_ABORTED` on caller signal, `SCAN_WAIT_TIMEOUT` at the
 * deadline (both carry the scan id and a resume hint), `VALIDATION_ERROR` for
 * bad options before any fetch, and any `LyraShieldError` from the poll
 * itself (401/403/404 propagate).
 */
export async function waitForScan(
  client: LyraShieldClient,
  scanId: string,
  options: WaitForScanOptions = {}
): Promise<ScanSnapshot> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const signal = options.signal

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LyraShieldError({
      status: 0,
      code: "VALIDATION_ERROR",
      message: "timeoutMs must be a positive number of milliseconds",
    })
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    throw new LyraShieldError({
      status: 0,
      code: "VALIDATION_ERROR",
      message: `pollIntervalMs must be >= ${MIN_POLL_INTERVAL_MS}`,
    })
  }
  if (signal?.aborted) throw waitAbortError(scanId)

  const deadline = Date.now() + timeoutMs
  let lastFingerprint: string | null = null
  // getScan accepts an etag for If-None-Match; the 200 response does not
  // surface a validator, so one is only adopted when the server hands us a
  // NotModified — never invented.
  let etag: string | undefined

  for (;;) {
    let result: Awaited<ReturnType<typeof getScan>>
    try {
      result = await getScan(client, scanId, {
        workspaceId: options.workspaceId,
        signal,
        ...(etag ? { etag } : {}),
      })
    } catch (err) {
      if (signal?.aborted) throw waitAbortError(scanId)
      // A Retry-After that outlived the client's internal retries becomes the
      // next poll delay, bounded by the wait deadline — never a second retry
      // layer and never a silently dropped throttle signal.
      if (err instanceof LyraShieldError && err.retryAfter !== undefined) {
        const waitMs = Math.min(err.retryAfter * 1000, deadline - Date.now())
        if (waitMs > 0) {
          try {
            await sleep(waitMs, signal)
          } catch {
            throw waitAbortError(scanId)
          }
          continue
        }
      }
      throw err
    }
    if (signal?.aborted) throw waitAbortError(scanId)

    if (isNotModified(result)) {
      // Unchanged since the validator we sent — adopt the returned validator
      // for later polls and keep waiting on the last known snapshot.
      if (result.etag) etag = result.etag
    } else {
      const snapshot = result
      const fingerprint = snapshotFingerprint(snapshot)
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint
        options.onProgress?.(snapshot)
      }
      if (TERMINAL_SCAN_STATUSES.includes(snapshot.status)) return snapshot
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) throw waitTimeoutError(scanId, timeoutMs)
    try {
      await sleep(Math.min(pollIntervalMs, remaining), signal)
    } catch {
      throw waitAbortError(scanId)
    }
  }
}
