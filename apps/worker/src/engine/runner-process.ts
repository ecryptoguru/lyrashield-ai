import { spawn, type ChildProcess } from "child_process"
import { logger } from "@lyrashield/logger"
import type { EngineCommand } from "./command-builder"
import { buildEngineEnv, type EngineProfile } from "./runner-config"
import { emitScanEvent } from "./runner-events"
import { parseEngineProgressFingerprint } from "./runner-output"
import {
  appendEngineStreamTail,
  createEngineStreamTail,
  flushEngineStreamTail,
  persistEngineStreamTail,
} from "./runner-tail"

const SIGKILL_GRACE_MS = 5000
// Purely informational "still running" ScanEvent row. Each tick is a Postgres
// insert competing with finding writes, and the UI polls on its own (slower)
// cadence, so 30s bought nothing: 2 minutes keeps the feed alive for a long scan
// at a quarter of the writes.
const ENGINE_HEARTBEAT_MS = 120_000
// A repository scan is allowed to continue while its engine receipt advances.
// This only terminates a process that has produced no durable progress at all.
const ENGINE_PROGRESS_POLL_MS = 15_000
const ENGINE_PROGRESS_STALL_MS = 20 * 60 * 1000
// Generous by design: a single long tool execution (e.g. a slow port scan) can
// legitimately span tens of minutes without an LLM turn, so this must stay
// comfortably above ENGINE_PROGRESS_STALL_MS to only catch a true model hang.
export const ENGINE_LLM_STALL_MS = 30 * 60 * 1000

/**
 * Grace margin above maxBudgetUsd before the worker backstop terminates the
 * engine. The engine normally self-stops at exit 3 (STOPPED_BUDGET) first;
 * this is the backstop for when it doesn't. The margin absorbs the lag between
 * the engine's last write and the next 15 s poll tick so a scan that is
 * legitimately approaching the cap is not killed prematurely. Founder-tunable.
 */
export const OVERSHOOT_GRACE = 0.075
const MAX_ENGINE_FAILURE_MARKER_WINDOW = 512

/**
 * Extract only the engine-owned exception class from its fixed non-interactive
 * failure marker. The surrounding stderr may contain target-derived content
 * and must never be logged or persisted.
 */
export function extractEngineFailureType(stderrTail: string): string | null {
  const marker = /Non-interactive scan failed: ([A-Za-z_][A-Za-z0-9_.]{0,127})/g
  let failureType: string | null = null
  for (const match of stderrTail.matchAll(marker)) failureType = match[1] ?? null
  return failureType
}

export function collectEngineFailureType(
  previousWindow: string,
  chunk: Buffer
): { window: string; failureType: string | null } {
  const window = `${previousWindow}${chunk.toString("utf8")}`.slice(
    -MAX_ENGINE_FAILURE_MARKER_WINDOW
  )
  return { window, failureType: extractEngineFailureType(window) }
}

interface KillableChild {
  kill(signal?: NodeJS.Signals): boolean
}

const activeEngineTerminators = new Set<() => void>()

export function trackActiveEngineProcess(terminate: () => void): () => void {
  activeEngineTerminators.add(terminate)
  return () => activeEngineTerminators.delete(terminate)
}

export function terminateActiveEngineProcesses(): number {
  const active = [...activeEngineTerminators]
  for (const terminate of active) terminate()
  return active.length
}

/**
 * Two-stage kill escalation for the engine child process. `onTimeout()` sends
 * SIGTERM and schedules a SIGKILL after `graceMs` UNLESS the process has exited
 * (signalled via `markExited()`). This deliberately tracks its own `exited`
 * flag rather than `child.killed`, which Node sets on signal *send* — see the
 * call site. Exported for unit testing. (S5)
 */
export function createKillEscalation(
  child: KillableChild,
  graceMs: number
): { onTimeout: () => void; markExited: () => void } {
  let exited = false
  let killTimer: ReturnType<typeof setTimeout> | null = null
  return {
    onTimeout() {
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL")
      }, graceMs)
    },
    markExited() {
      exited = true
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
    },
  }
}
export async function runEngineProcess(
  cmd: EngineCommand,
  absWorkDir: string,
  scanId: string,
  timeoutMs: number | null,
  profile: EngineProfile,
  shouldCancel?: () => Promise<boolean>,
  readProgressFingerprint?: () => Promise<string | null>,
  maxBudgetUsd?: number,
  readSpendUsd?: () => Promise<number | null>,
  onAgentLoopTick?: (elapsedMs: number) => void,
  relay?: { url: string; grant: string },
  runType?: string
): Promise<{
  exitCode: number
  timedOut: boolean
  timeoutReason: "DURATION" | "INACTIVITY" | "LLM_STALL" | null
  cancelled: boolean
  budgetKilled: boolean
  failureType: string | null
}> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(cmd.executable, cmd.args, {
      cwd: absWorkDir,
      env: buildEngineEnv(profile, scanId, { runType, relay }),
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdoutBytes = 0
    let stderrBytes = 0
    // Capture only the engine-owned fixed failure class. Raw stream content can
    // contain target or credential data and must not enter operational logs.
    let failureMarkerWindow = ""
    let failureType: string | null = null
    // Bounded redacted tails of the raw streams for failure diagnosis. Held in
    // memory only; never logged. Persisted to encrypted evidence storage on a
    // non-zero exit so "engine exited code 1, no detail" is diagnosable without
    // exposing target/credential content in operational logs.
    const stdoutTail = createEngineStreamTail()
    const stderrTail = createEngineStreamTail()
    let timedOut = false
    let timeoutReason: "DURATION" | "INACTIVITY" | "LLM_STALL" | null = null
    let cancelled = false
    let budgetKilled = false
    let closed = false
    let terminationRequested = false
    let progressFingerprint: string | null = null
    let lastProgressAt = Date.now()
    let progressCheckInFlight = false
    // LLM stall detector: the liveness fingerprint advances on ANY run.json
    // save, so an engine that keeps persisting artifacts while its model calls
    // hang never trips the INACTIVITY stall, and a frozen self-reported spend
    // never trips the budget backstop. Turn-count movement is the distinct
    // "model is still doing work" signal.
    let lastLlmTurnCount: number | null = null
    let lastLlmProgressAt = Date.now()

    const escalation = createKillEscalation(child, SIGKILL_GRACE_MS)
    const terminate = () => {
      if (terminationRequested) return
      terminationRequested = true
      escalation.onTimeout()
    }
    const stopTracking = trackActiveEngineProcess(terminate)

    const timer =
      typeof timeoutMs === "number"
        ? setTimeout(() => {
            timedOut = true
            timeoutReason = "DURATION"
            terminate()
          }, timeoutMs)
        : null
    const cancellationTimer = shouldCancel
      ? setInterval(() => {
          void shouldCancel()
            .then((isCancelled) => {
              if (!closed && isCancelled) {
                cancelled = true
                terminate()
              }
            })
            .catch(() => {})
        }, 1000)
      : null
    const startedAt = Date.now()
    const spendCeilingUsd =
      typeof maxBudgetUsd === "number" && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0
        ? maxBudgetUsd * (1 + OVERSHOOT_GRACE)
        : null
    const pollProgress = () => {
      if (!readProgressFingerprint || closed || progressCheckInFlight) return
      progressCheckInFlight = true
      void readProgressFingerprint()
        .then((nextFingerprint) => {
          if (closed) return
          if (nextFingerprint && nextFingerprint !== progressFingerprint) {
            progressFingerprint = nextFingerprint
            lastProgressAt = Date.now()
            // Sprint 10: emit wall-clock duration signal to the metering hook
            // on each agent-loop tick. Per D1: wall-clock, NOT active-loop.
            if (onAgentLoopTick) {
              onAgentLoopTick(Date.now() - startedAt)
            }
          } else if (Date.now() - lastProgressAt >= ENGINE_PROGRESS_STALL_MS) {
            timedOut = true
            timeoutReason = "INACTIVITY"
            terminate()
            return
          }
          // Model-progress stall: while the run reports itself RUNNING, a
          // turn count that stops advancing means the engine is persisting
          // artifacts (liveness fingerprint keeps moving) without any model
          // activity — a hang the spend backstop and INACTIVITY stall both miss.
          if (nextFingerprint) {
            const progress = parseEngineProgressFingerprint(nextFingerprint)
            if (progress) {
              if (progress.turnCount !== lastLlmTurnCount) {
                lastLlmTurnCount = progress.turnCount
                lastLlmProgressAt = Date.now()
              } else if (
                progress.phase === "running" &&
                Date.now() - lastLlmProgressAt >= ENGINE_LLM_STALL_MS
              ) {
                timedOut = true
                timeoutReason = "LLM_STALL"
                terminate()
                return
              }
            }
          }
          // Budget backstop: read the live cumulative spend from the same
          // receipt and terminate when it crosses the grace-adjusted ceiling.
          // A null read (missing/malformed) is fail-open — no trip.
          if (spendCeilingUsd !== null && readSpendUsd && !closed) {
            return readSpendUsd().then((observedSpend) => {
              if (closed || observedSpend === null) return
              if (observedSpend >= spendCeilingUsd) {
                budgetKilled = true
                terminate()
              }
            })
          }
        })
        .catch(() => {
          // A transient receipt read failure is not evidence that the engine stopped.
        })
        .finally(() => {
          progressCheckInFlight = false
        })
    }
    const progressTimer = readProgressFingerprint
      ? setInterval(pollProgress, ENGINE_PROGRESS_POLL_MS)
      : null
    pollProgress()
    const heartbeatTimer = setInterval(() => {
      void emitScanEvent(scanId, "engine_activity", "info", "AI analysis is still running", {
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        ...(readProgressFingerprint
          ? { secondsSinceDurableProgress: Math.round((Date.now() - lastProgressAt) / 1000) }
          : {}),
      })
    }, ENGINE_HEARTBEAT_MS)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      appendEngineStreamTail(stdoutTail, chunk)
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      appendEngineStreamTail(stderrTail, chunk)
      const marker = collectEngineFailureType(failureMarkerWindow, chunk)
      failureMarkerWindow = marker.window
      failureType = marker.failureType ?? failureType
    })

    child.on("close", async (code) => {
      closed = true
      if (timer) clearTimeout(timer)
      clearInterval(heartbeatTimer)
      if (progressTimer) clearInterval(progressTimer)
      if (cancellationTimer) clearInterval(cancellationTimer)
      escalation.markExited()
      stopTracking()
      const exitCode = code ?? (timedOut || cancelled || budgetKilled ? -1 : 1)
      logger.info("Engine streams consumed", { scanId, stdoutBytes, stderrBytes })
      if (exitCode !== 0) {
        logger.warn("Engine exited with an error", {
          scanId,
          exitCode,
          ...(failureType ? { failureType } : {}),
        })
        // Emit any trailing partial line before persisting (a stream that
        // ended without a newline — its last line is still pending).
        flushEngineStreamTail(stdoutTail)
        flushEngineStreamTail(stderrTail)
        // Persist a bounded, redacted tail of both streams to encrypted
        // evidence storage so a non-zero exit is diagnosable. Raw stream
        // content can carry target or credential data and must never enter
        // operational logs — the tail goes to the encrypted store only, and
        // the scan event references the artifact URI. Startup/clone errors
        // land on stdout, which is exactly the case the byte counts alone
        // could not explain.
        await persistEngineStreamTail(scanId, exitCode, failureType, stdoutTail, stderrTail)
      }
      resolvePromise({
        exitCode,
        timedOut,
        timeoutReason,
        cancelled,
        budgetKilled,
        failureType,
      })
    })

    child.on("error", (err) => {
      closed = true
      if (timer) clearTimeout(timer)
      clearInterval(heartbeatTimer)
      if (progressTimer) clearInterval(progressTimer)
      if (cancellationTimer) clearInterval(cancellationTimer)
      escalation.markExited()
      stopTracking()
      reject(err)
    })
  })
}
