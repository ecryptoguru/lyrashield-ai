import { setTimeout as sleep } from "node:timers/promises"
import { z } from "zod"
import type { LyraShieldClient } from "../client"
import { LyraShieldError, NotModified } from "../errors"
import { ScanSchema } from "../schemas"
import { getScan } from "./scans"

type ScanSnapshot = z.infer<typeof ScanSchema>

export interface WaitForScanOptions {
  workspaceId?: string
  signal?: AbortSignal
  timeoutMs?: number
  pollIntervalMs?: number
  onProgress?: (scan: ScanSnapshot) => void
}

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])

/** Waits for an existing scan only; never submits or cancels work. */
export async function waitForScan(
  client: LyraShieldClient,
  scanId: string,
  options: WaitForScanOptions = {}
): Promise<ScanSnapshot> {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 5_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new RangeError("timeoutMs must be between 1 and 86400000")
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1_000) {
    throw new RangeError("pollIntervalMs must be at least 1000")
  }
  const deadline = Date.now() + timeoutMs
  let lastStatus: string | undefined
  let lastUpdatedAt: string | undefined

  while (true) {
    if (options.signal?.aborted) {
      throw new LyraShieldError({
        status: 0,
        code: "REQUEST_ABORTED",
        message: `Stopped waiting for scan ${scanId}; scan may still be running`,
      })
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new LyraShieldError({
        status: 0,
        code: "WAIT_TIMEOUT",
        message: `Timed out waiting for scan ${scanId}; resume with this scan ID`,
      })
    }
    const deadlineSignal = AbortSignal.timeout(remainingMs)
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadlineSignal])
      : deadlineSignal
    let scan: ScanSnapshot | NotModified
    try {
      scan = await getScan(client, scanId, { workspaceId: options.workspaceId, signal })
    } catch (error) {
      if (error instanceof LyraShieldError && error.code === "REQUEST_ABORTED") {
        // The request may have been cancelled by our wait deadline.
        if (!options.signal?.aborted) continue
      }
      if (error instanceof LyraShieldError && error.status === 429 && error.retryAfter) {
        try {
          await sleep(
            Math.min(error.retryAfter * 1_000, Math.max(1, deadline - Date.now())),
            undefined,
            {
              signal,
            }
          )
        } catch (sleepError) {
          if (!(sleepError instanceof Error && sleepError.name === "AbortError")) throw sleepError
          if (options.signal?.aborted) {
            throw new LyraShieldError({
              status: 0,
              code: "REQUEST_ABORTED",
              message: `Stopped waiting for scan ${scanId}; scan may still be running`,
            })
          }
        }
        continue
      }
      throw error
    }
    if (!(scan instanceof NotModified)) {
      if (scan.status !== lastStatus || scan.updatedAt !== lastUpdatedAt) {
        options.onProgress?.(scan)
        lastStatus = scan.status
        lastUpdatedAt = scan.updatedAt
      }
      if (TERMINAL_STATUSES.has(scan.status)) return scan
    }
    try {
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, {
        signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (!options.signal?.aborted) continue
        throw new LyraShieldError({
          status: 0,
          code: "REQUEST_ABORTED",
          message: `Stopped waiting for scan ${scanId}; scan may still be running`,
        })
      }
      throw error
    }
  }
}
