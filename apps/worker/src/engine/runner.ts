import { execFile, spawn, type ChildProcess } from "child_process"
import { constants as fsConstants } from "fs"
import { rm, mkdir, readdir, stat, lstat, realpath, open, writeFile } from "fs/promises"
import { join, relative, resolve, sep } from "path"
import { promisify } from "util"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { buildEngineCommand, type ScanConfig, type EngineCommand } from "./command-builder"
import { parseEngineOutput, type ParsedScanOutput } from "./output-parser"
import {
  parseEngineTriageArtifact,
  type EngineTriageArtifact,
} from "@lyrashield/security/ai-security"
import { ENGINE_CHECKOUT_ROOT, ENGINE_TEMP_ROOT, ENGINE_WORK_ROOT } from "./workspace-path"

export interface EngineRunResult {
  exitCode: number
  cancelled: boolean
  timedOut: boolean
  timeoutReason?: "DURATION" | "INACTIVITY" | "LLM_STALL" | null
  /**
   * The worker backstop killed the engine because the polled run.json
   * llm_usage.cost crossed the protected budget ceiling (maxBudgetUsd ×
   * (1 + OVERSHOOT_GRACE)). This is NOT an error — it maps to STOPPED_BUDGET,
   * the same terminal status the engine's own exit-3 self-stop uses.
   */
  budgetKilled?: boolean
  output: ParsedScanOutput
  /** Validated host-side checkout for deterministic repository scanners. */
  sourceCheckoutPath: string | null
  /** Immutable Git commit actually checked out for repository scanners. */
  sourceRevision?: string | null
  /** Host-observed confirmation that no sandbox owned by this scan remains. */
  sandboxRemoved?: boolean
}

const execFileAsync = promisify(execFile)

const SANDBOX_RECEIPT_TIMEOUT_MS = 10_000

async function verifySandboxRemoved(scanId: string): Promise<boolean | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) {
    return undefined
  }
  try {
    // Use `docker ps -a` (all containers), not just running ones. A sandbox that
    // exited but was never removed must still count as "not removed" — otherwise a
    // stopped container reports sandboxRemoved:true and leaks the resource receipt.
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-a", "--filter", `label=strix-run-id=${scanId}`, "--quiet"],
      { timeout: SANDBOX_RECEIPT_TIMEOUT_MS, maxBuffer: 16 * 1024 }
    )
    return stdout.trim() === ""
  } catch (error) {
    logger.warn("Could not verify terminal sandbox cleanup", {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

const EXIT_CODE_MAP: Record<
  number,
  { status: "COMPLETED" | "FAILED"; category: string; message: string }
> = {
  0: { status: "COMPLETED", category: "SUCCESS", message: "Scan completed successfully" },
  1: { status: "FAILED", category: "ENGINE_ERROR", message: "Engine exited with an error" },
  2: {
    status: "COMPLETED",
    category: "VULNERABILITIES_FOUND",
    message: "Scan completed with vulnerabilities found",
  },
  3: {
    status: "FAILED",
    category: "BUDGET_EXCEEDED",
    message: "Engine stopped at the protected budget limit",
  },
  4: {
    status: "FAILED",
    category: "RATE_LIMITED",
    message: "Engine stopped because the model provider rate limited the scan",
  },
  5: {
    status: "FAILED",
    category: "ENGINE_INCOMPLETE",
    message: "Engine ended without a completed scan receipt",
  },
  [-2]: {
    status: "FAILED",
    category: "INFRA_ERROR",
    message: "Engine runtime could not be started",
  },
}

export function interpretExitCode(
  code: number,
  signal?: NodeJS.Signals | null
): {
  status: "COMPLETED" | "FAILED"
  category: string
  message: string
} {
  if (code === 137 || signal === "SIGKILL") {
    return {
      status: "FAILED",
      category: "INFRA_ERROR",
      message: "Engine was killed by its runtime",
    }
  }
  return (
    EXIT_CODE_MAP[code] ?? {
      status: "FAILED",
      category: "ENGINE_ERROR",
      message: `Engine exited with code ${code}`,
    }
  )
}

const MAX_ENGINE_VULNERABILITIES_BYTES = 10 * 1024 * 1024
const MAX_ENGINE_RUN_BYTES = 1 * 1024 * 1024
const MAX_ENGINE_TRIAGE_ARTIFACT_BYTES = 128 * 1024
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
const ENGINE_LLM_STALL_MS = 30 * 60 * 1000

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

export interface KillableChild {
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

export type ReasoningEffort = "medium" | "high"

export interface EngineProfile {
  model?: string
  reasoningEffort: ReasoningEffort
  delegateModel?: string
  delegateReasoningEffort: ReasoningEffort
}

function assertSupportedRepositoryModel(model: string | undefined): void {
  const normalizedModel = model?.toLowerCase().replaceAll("_", "-")
  if (normalizedModel && !/(?:^|[/.-])gpt-5\.6-(?:terra|luna)(?:$|[/.-])/.test(normalizedModel)) {
    throw new Error("LyraShield scans require a GPT-5.6 Terra or Luna deployment")
  }
}

export function resolveEngineProfile(
  mode: string,
  routingEnv: NodeJS.ProcessEnv = process.env
): EngineProfile {
  const deep = mode.toUpperCase() === "DEEP" || mode.toUpperCase() === "CUSTOM"
  const selectedModel = deep ? routingEnv.LYRASHIELD_TERRA_LLM : routingEnv.LYRASHIELD_LUNA_LLM
  const model = selectedModel?.trim() || routingEnv.LYRASHIELD_LLM?.trim() || undefined
  const delegateModel = routingEnv.LYRASHIELD_LUNA_LLM?.trim() || model
  assertSupportedRepositoryModel(model)
  assertSupportedRepositoryModel(delegateModel)

  // DEEP/CUSTOM: Terra/medium coordinator + Luna/high specialists.
  // SAFE/QUICK/STANDARD: Luna/medium throughout.
  // Rationale: Azure's content filter blocks Terra on security-sensitive output;
  // Luna/high gives specialists more reasoning budget for deep code analysis
  // while keeping Terra only for lightweight root coordination. On a root
  // content-filter block, the engine falls back directly to Luna/high without
  // retrying Terra (see strix/core/runner.py).
  return {
    model,
    reasoningEffort: "medium",
    delegateModel,
    delegateReasoningEffort: deep ? "high" : "medium",
  }
}

export function resolveEngineSandboxNetwork(runtimeEnv: NodeJS.ProcessEnv = process.env): string {
  const network = runtimeEnv.LYRASHIELD_ENGINE_SANDBOX_NETWORK?.trim()
  if (!network || network.toLowerCase() === "none") {
    throw new Error(
      "LYRASHIELD_ENGINE_SANDBOX_NETWORK must name a routable, egress-restricted Docker network"
    )
  }
  return network
}

export function assertRepositoryScanRuntimeConfigured(
  runtimeEnv: NodeJS.ProcessEnv = process.env
): void {
  requireRepositoryModel(resolveEngineProfile("SAFE", runtimeEnv).model)
  requireRepositoryModel(resolveEngineProfile("DEEP", runtimeEnv).model)
  if (!(
    runtimeEnv.LLM_API_KEY ||
    runtimeEnv.AZURE_OPENAI_API_KEY ||
    runtimeEnv.AZURE_AI_API_KEY ||
    runtimeEnv.OPENAI_API_KEY
  )) {
    throw new Error("A model provider credential must be configured for repository scans")
  }
  resolveEngineSandboxNetwork(runtimeEnv)
  if (runtimeEnv.NODE_ENV === "production") {
    const image = runtimeEnv.LYRASHIELD_IMAGE ?? ""
    if (!/^ghcr\.io\/ecryptoguru\/lyrashield-sandbox@sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error(
        "LYRASHIELD_IMAGE must be a LyraShield-owned immutable sha256 digest in production"
      )
    }
    const dockerHost = runtimeEnv.DOCKER_HOST?.trim() ?? ""
    // A remote, isolated sandbox host (ssh:// or tls tcp://) is the strongest
    // posture and stays the default. A single-VM deployment — the worker runs
    // the engine against the VM's LOCAL Docker daemon and isolates scans with a
    // dedicated egress-restricted network plus a deny-by-default firewall (see
    // ops/worker/README.md) — is supported as an explicit, name-clear opt-in via
    // LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST=1. That opt-in is honored ONLY when a
    // routable egress-restricted sandbox network is also configured (the
    // resolveEngineSandboxNetwork check above), so a bare local Docker socket
    // with no network isolation still fails.
    const allowLocalSandboxHost =
      (runtimeEnv.LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST ?? "").trim().toLowerCase() === "1" ||
      (runtimeEnv.LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST ?? "").trim().toLowerCase() === "true"
    const isRemoteDockerHost = /^ssh:\/\//.test(dockerHost) || /^tcp:\/\//.test(dockerHost)
    if (!isRemoteDockerHost && !allowLocalSandboxHost) {
      throw new Error(
        "DOCKER_HOST must be an ssh:// or tcp:// endpoint for an isolated sandbox worker in production"
      )
    }
    if (/^tcp:\/\//.test(dockerHost) && runtimeEnv.DOCKER_TLS_VERIFY !== "1") {
      throw new Error("DOCKER_TLS_VERIFY=1 is required for a tcp:// production DOCKER_HOST")
    }
  }
}

function requireRepositoryModel(model: string | undefined): string {
  if (!model) {
    throw new Error("A GPT-5.6 Terra or Luna deployment must be configured")
  }
  return model
}

const WEB_SEARCH_DEFAULTS: Record<string, string> = {
  LYRASHIELD_WEB_SEARCH_PROVIDER: "parallel",
  LYRASHIELD_WEB_SEARCH_MODE: "turbo",
  LYRASHIELD_WEB_SEARCH_MAX_RESULTS: "5",
  LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL: "4000",
  LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN: "50",
  LYRASHIELD_WEB_SEARCH_BUDGET_USD: "1.0",
}

export function buildEngineEnv(profile: EngineProfile, scanId?: string): Record<string, string> {
  const allow = new Set([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "LYRASHIELD_LLM",
    "LLM_API_KEY",
    "LLM_API_BASE",
    "LLM_API_VERSION",
    "LLM_TIMEOUT",
    "LYRASHIELD_MAX_OUTPUT_TOKENS",
    "LYRASHIELD_MAX_INPUT_TOKENS",
    "LYRASHIELD_PROMPT_CACHE_EXPLICIT",
    "LYRASHIELD_PROMPT_CACHE",
    "LYRASHIELD_IMAGE",
    "LYRASHIELD_RUNTIME_BACKEND",
    "LYRASHIELD_SERVER_CONVERSATION",
    "LYRASHIELD_MAX_LOCAL_COPY_MB",
    "LYRASHIELD_REASONING_EFFORT",
    "LYRASHIELD_TELEMETRY",
    "LYRASHIELD_WEB_SEARCH_ENABLED",
    "LYRASHIELD_WEB_SEARCH_API_KEY",
    "LYRASHIELD_WEB_SEARCH_PROVIDER",
    "LYRASHIELD_WEB_SEARCH_MODE",
    "LYRASHIELD_WEB_SEARCH_MAX_RESULTS",
    "LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL",
    "LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN",
    "LYRASHIELD_WEB_SEARCH_BUDGET_USD",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_BASE",
    "AZURE_AI_API_KEY",
    "AZURE_AI_API_BASE",
    "AZURE_API_VERSION",
    "AZURE_OPENAI_API_VERSION",
  ])
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value === "") continue
    if (allow.has(key)) {
      filtered[key] = value
    }
  }
  if (!("LYRASHIELD_PROMPT_CACHE_EXPLICIT" in filtered)) {
    filtered.LYRASHIELD_PROMPT_CACHE_EXPLICIT = "1"
  }
  if (!("LYRASHIELD_PROMPT_CACHE" in filtered)) {
    filtered.LYRASHIELD_PROMPT_CACHE = "1"
  }
  // The engine clones repositories below TMPDIR before asking host Docker to
  // bind-mount them into the sandbox. Keep the child on the same host-visible
  // temp root as the worker; /tmp inside the worker container is not visible
  // to the host Docker daemon.
  filtered.TMPDIR = ENGINE_TEMP_ROOT
  if (profile.model) filtered.LYRASHIELD_LLM = profile.model
  filtered.LYRASHIELD_REASONING_EFFORT = profile.reasoningEffort
  if (profile.delegateModel) filtered.LYRASHIELD_DELEGATE_LLM = profile.delegateModel
  filtered.LYRASHIELD_DELEGATE_REASONING_EFFORT = profile.delegateReasoningEffort
  if (scanId) {
    filtered.STRIX_RUN_ID = scanId
    filtered.STRIX_RUN_TYPE = "repository"
  }
  filtered.STRIX_DOCKER_SANDBOX_NETWORK = resolveEngineSandboxNetwork()
  filtered.STRIX_SANDBOX_MEM_LIMIT = env.STRIX_SANDBOX_MEM_LIMIT.trim() || "4g"
  filtered.STRIX_SANDBOX_CPUS = env.STRIX_SANDBOX_CPUS.trim() || "2"
  filtered.STRIX_SANDBOX_PIDS_LIMIT = env.STRIX_SANDBOX_PIDS_LIMIT.trim() || "512"

  // Only forward web-search tuning defaults when the feature is enabled; this
  // keeps disabled runs from silently carrying a provider/budget and gives the
  // engine a predictable, complete environment when enabled.
  if (filtered.LYRASHIELD_WEB_SEARCH_ENABLED === "1") {
    for (const [key, defaultValue] of Object.entries(WEB_SEARCH_DEFAULTS)) {
      if (!filtered[key]) filtered[key] = defaultValue
    }
  }

  return filtered
}

async function emitScanEvent(
  scanId: string,
  stage: string,
  level: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await addScanEvent(scanId, stage, level, message, metadata)
  } catch (err) {
    logger.warn("Failed to persist scan event", {
      scanId,
      stage,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function runEngineProcess(
  cmd: EngineCommand,
  absWorkDir: string,
  scanId: string,
  timeoutMs: number | null,
  profile: EngineProfile,
  shouldCancel?: () => Promise<boolean>,
  readProgressFingerprint?: () => Promise<string | null>,
  maxBudgetUsd?: number,
  readSpendUsd?: () => Promise<number | null>,
  onAgentLoopTick?: (elapsedMs: number) => void
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
      env: buildEngineEnv(profile, scanId),
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdoutBytes = 0
    let stderrBytes = 0
    // Capture only the engine-owned fixed failure class. Raw stream content can
    // contain target or credential data and must not enter operational logs.
    let failureMarkerWindow = ""
    let failureType: string | null = null
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
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      const marker = collectEngineFailureType(failureMarkerWindow, chunk)
      failureMarkerWindow = marker.window
      failureType = marker.failureType ?? failureType
    })

    child.on("close", (code) => {
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

const ENGINE_RUN_LAYOUTS = ["strix_runs", "lyrashield_runs"] as const
const ENGINE_OUTPUT_ARTIFACTS = ["run.json", "vulnerabilities.json"] as const
const MAX_RUN_OUTPUT_ENTRIES = 50_000

/**
 * Extract only a repository checkout created by the engine below its dedicated
 * temporary root. A run artifact must never redirect scanners to arbitrary
 * worker files.
 */
export async function resolveEngineSourceCheckout(
  runRecord: ParsedScanOutput["runRecord"]
): Promise<string | null> {
  if (!Array.isArray(runRecord?.targets_info)) return null

  let checkoutRoot: string
  try {
    // ENGINE_CHECKOUT_ROOT is a fixed constant under the system temp directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    checkoutRoot = await realpath(ENGINE_CHECKOUT_ROOT)
  } catch {
    return null
  }

  for (const target of runRecord.targets_info) {
    if (typeof target !== "object" || target === null) continue
    const details = (target as { details?: unknown }).details
    if (typeof details !== "object" || details === null) continue
    const sourcePath = (details as { cloned_repo_path?: unknown }).cloned_repo_path
    if (typeof sourcePath !== "string" || !sourcePath.trim()) continue

    try {
      // sourcePath comes from the engine run record and is validated against the checkout root.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const checkout = await realpath(sourcePath)
      const pathFromRoot = relative(checkoutRoot, checkout)
      if (
        pathFromRoot === "" ||
        pathFromRoot === ".." ||
        pathFromRoot.startsWith(`..${sep}`) ||
        resolve(checkoutRoot, pathFromRoot) !== checkout
      ) {
        logger.warn("Engine checkout path escaped the expected root", { sourcePath })
        continue
      }
      // checkout has already been resolved and confined to the engine checkout root.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if ((await stat(checkout)).isDirectory()) return checkout
    } catch {
      // Missing checkouts are a coverage gap, not an empty source scan.
    }
  }

  return null
}

export async function resolveEngineSourceRevision(
  checkoutPath: string | null
): Promise<string | null> {
  if (!checkoutPath) return null
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", checkoutPath, "rev-parse", "--verify", "HEAD"],
      {
        timeout: 5_000,
        maxBuffer: 1_024,
      }
    )
    const revision = stdout.trim().toLowerCase()
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null
  } catch {
    return null
  }
}

async function hasEngineOutputArtifact(runDir: string): Promise<boolean> {
  for (const artifact of ENGINE_OUTPUT_ARTIFACTS) {
    try {
      // artifact names are fixed and joined to a validated run directory.
      // Use lstat so a symlink (even one pointing to a file) does not count.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const artifactStat = await lstat(join(runDir, artifact))
      if (artifactStat.isFile()) return true
    } catch {
      // Try the next expected artifact.
    }
  }
  return false
}

export async function findRunOutputDir(
  workDir: string,
  expectedRunName?: string
): Promise<string | null> {
  let newest: { path: string; mtimeMs: number } | null = null
  let entriesSeen = 0

  for (const layout of ENGINE_RUN_LAYOUTS) {
    const runsDir = join(workDir, layout)
    try {
      // runsDir is a fixed layout under the resolved engine work directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const entry of await readdir(runsDir)) {
        if (++entriesSeen > MAX_RUN_OUTPUT_ENTRIES) {
          logger.warn("Engine run output walk capped", {
            workDir,
            maxEntries: MAX_RUN_OUTPUT_ENTRIES,
          })
          break
        }
        if (expectedRunName && entry !== expectedRunName) continue
        const entryPath = join(runsDir, entry)
        try {
          // entryPath is inside the validated run layout and is not used as a destination.
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          const entryStat = await lstat(entryPath)
          if (entryStat.isSymbolicLink()) continue
          if (!entryStat.isDirectory() || !(await hasEngineOutputArtifact(entryPath))) continue
          if (!newest || entryStat.mtimeMs > newest.mtimeMs) {
            newest = { path: entryPath, mtimeMs: entryStat.mtimeMs }
          }
        } catch {
          // A disappearing/unreadable run must not fail the worker.
        }
      }
    } catch {
      logger.debug("Engine run layout not found", { runsDir })
    }
  }

  return newest?.path ?? null
}

export async function prepareEngineWorkspace(workDir: string): Promise<void> {
  const workspace = resolve(workDir)
  const workspaceFromRoot = relative(ENGINE_WORK_ROOT, workspace)
  if (
    !workspaceFromRoot ||
    workspaceFromRoot === ".." ||
    workspaceFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error("Refusing to prepare an engine workspace outside the owned run root")
  }
  // The work directory belongs to one scan id. Clearing it before launch
  // prevents a crashed attempt's receipt from being mistaken for this attempt.
  await rm(workspace, { recursive: true, force: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(workspace, { recursive: true })
}

async function readTextFileBounded(path: string, maxBytes: number): Promise<string> {
  // The artifact location is selected only from a validated engine output directory.
  // O_NOFOLLOW and fstat reject symlinked or special-file artifacts without a
  // pre-open lstat/TOCTOU gap.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      throw new Error(`Engine artifact is not a regular file: ${path}`)
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, maxBytes + 1 - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error(`Engine artifact exceeds ${maxBytes} byte limit`)
    return buffer.subarray(0, offset).toString("utf8")
  } finally {
    await handle.close()
  }
}

/** Reads only the engine's bounded monotonic liveness fields. */
export async function readEngineProgressFingerprint(
  workDir: string,
  expectedRunName: string
): Promise<string | null> {
  const outputDir = await findRunOutputDir(workDir, expectedRunName)
  if (!outputDir) return null

  let raw: string
  try {
    raw = await readTextFileBounded(join(outputDir, "run.json"), MAX_ENGINE_RUN_BYTES)
  } catch {
    return null
  }

  try {
    const record = JSON.parse(raw) as { seq?: unknown; turn_count?: unknown; phase?: unknown }
    if (
      !Number.isInteger(record.seq) ||
      (record.seq as number) < 0 ||
      !Number.isInteger(record.turn_count) ||
      (record.turn_count as number) < 0 ||
      !["setup", "running", "finalizing", "completed", "stopped"].includes(record.phase as string)
    ) {
      return null
    }
    return `${record.seq}:${record.turn_count}:${record.phase}`
  } catch {
    return null
  }
}

/**
 * Inverse of the fingerprint string readEngineProgressFingerprint emits, for
 * detectors that need the individual liveness fields (turn count, phase).
 * Returns null for a fingerprint from an unexpected format.
 */
export function parseEngineProgressFingerprint(
  fingerprint: string
): { seq: number; turnCount: number; phase: string } | null {
  const parts = fingerprint.split(":")
  if (parts.length !== 3) return null
  const seq = Number(parts[0])
  const turnCount = Number(parts[1])
  if (!Number.isInteger(seq) || seq < 0) return null
  if (!Number.isInteger(turnCount) || turnCount < 0) return null
  if (!["setup", "running", "finalizing", "completed", "stopped"].includes(parts[2]!)) return null
  return { seq, turnCount, phase: parts[2]! }
}

/**
 * Reads the live cumulative LLM spend (run.json -> llm_usage -> cost) from the
 * same engine receipt the fingerprint poll already opens. Returns null when the
 * file, the llm_usage object, or the cost field is missing or malformed —
 * treated as "no spend signal yet", NEVER as "over budget" (fail-open on read).
 */
export async function readEngineSpendUsd(
  workDir: string,
  expectedRunName: string
): Promise<number | null> {
  const outputDir = await findRunOutputDir(workDir, expectedRunName)
  if (!outputDir) return null

  let raw: string
  try {
    raw = await readTextFileBounded(join(outputDir, "run.json"), MAX_ENGINE_RUN_BYTES)
  } catch {
    return null
  }

  try {
    const record = JSON.parse(raw) as { llm_usage?: unknown }
    const usage = record.llm_usage
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null
    const cost = (usage as { cost?: unknown }).cost
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null
    return cost
  } catch {
    return null
  }
}

async function readEngineOutput(outputDir: string): Promise<{
  vulnerabilitiesRaw: string
  runJsonRaw: string
}> {
  let vulnerabilitiesRaw = ""
  let runJsonRaw = ""

  try {
    vulnerabilitiesRaw = await readTextFileBounded(
      join(outputDir, "vulnerabilities.json"),
      MAX_ENGINE_VULNERABILITIES_BYTES
    )
  } catch (error) {
    logger.warn("vulnerabilities.json unavailable or oversized", {
      outputDir,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    runJsonRaw = await readTextFileBounded(join(outputDir, "run.json"), MAX_ENGINE_RUN_BYTES)
  } catch (error) {
    logger.warn("run.json unavailable or oversized", {
      outputDir,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return { vulnerabilitiesRaw, runJsonRaw }
}

export async function runEngine(
  config: ScanConfig,
  scanId: string,
  timeoutMs: number | null = null,
  shouldCancel?: () => Promise<boolean>,
  onAgentLoopTick?: (elapsedMs: number) => void
): Promise<EngineRunResult> {
  if (shouldCancel && (await shouldCancel())) {
    return {
      exitCode: -1,
      cancelled: true,
      timedOut: false,
      timeoutReason: null,
      budgetKilled: false,
      output: parseEngineOutput("", ""),
      sourceCheckoutPath: null,
    }
  }

  const cmd = buildEngineCommand(config)
  const profile = resolveEngineProfile(config.mode)

  const absWorkDir = resolve(cmd.workDir)
  await prepareEngineWorkspace(absWorkDir)

  logger.info("Starting engine process", {
    scanId,
    executable: cmd.executable,
    argumentCount: cmd.args.length,
    workDir: absWorkDir,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
  })

  await emitScanEvent(scanId, "engine_start", "info", "Starting LyraShield scan engine", {
    model: profile.model ?? "fallback",
    reasoningEffort: profile.reasoningEffort,
  })

  let processResult
  try {
    processResult = await runEngineProcess(
      cmd,
      absWorkDir,
      scanId,
      timeoutMs,
      profile,
      shouldCancel,
      () => readEngineProgressFingerprint(absWorkDir, scanId),
      config.maxBudgetUsd,
      () => readEngineSpendUsd(absWorkDir, scanId),
      onAgentLoopTick
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "EACCES") throw error
    await emitScanEvent(scanId, "engine_infra", "error", "Engine runtime could not be started", {
      code,
    })
    processResult = {
      exitCode: -2,
      timedOut: false,
      timeoutReason: null,
      cancelled: false,
      budgetKilled: false,
      failureType: null,
    }
  }
  const { exitCode, timedOut, timeoutReason, cancelled, budgetKilled, failureType } = processResult

  if (timedOut) {
    const timeoutMessage =
      timeoutReason === "INACTIVITY"
        ? "Engine stopped after no durable progress was observed"
        : timeoutReason === "LLM_STALL"
          ? `Engine stopped after ${ENGINE_LLM_STALL_MS / 60000} minutes without model activity`
          : `Engine timed out after ${(timeoutMs ?? 0) / 1000}s`
    await emitScanEvent(scanId, "engine_timeout", "error", timeoutMessage, {
      timeoutReason,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    })
    logger.error("Engine timed out", { scanId, timeoutMs, timeoutReason })
  } else {
    await emitScanEvent(scanId, "engine_exit", "info", `Engine exited with code ${exitCode}`, {
      exitCode,
    })
  }

  logger.info("Engine process finished", {
    scanId,
    exitCode,
    timedOut,
    timeoutReason,
    failureType,
  })

  if (exitCode === 1 && failureType) {
    await emitScanEvent(
      scanId,
      "engine_error_class",
      "error",
      `Engine analysis stopped unexpectedly (${failureType})`,
      { failureType }
    )
  }

  const outputDir = await findRunOutputDir(absWorkDir, scanId)
  const { vulnerabilitiesRaw, runJsonRaw } = outputDir
    ? await readEngineOutput(outputDir)
    : { vulnerabilitiesRaw: "", runJsonRaw: "" }

  const output = parseEngineOutput(vulnerabilitiesRaw, runJsonRaw)
  const sourceCheckoutPath = await resolveEngineSourceCheckout(output.runRecord)
  const sourceRevision = await resolveEngineSourceRevision(sourceCheckoutPath)
  const sandboxRemoved = await verifySandboxRemoved(scanId)

  if (config.target.type === "REPO") {
    await emitScanEvent(
      scanId,
      "source_checkout",
      sourceCheckoutPath ? "info" : "warning",
      sourceCheckoutPath
        ? "Validated engine source checkout for deterministic scanners"
        : "Validated engine source checkout unavailable; source-dependent scanners will report bounded coverage",
      { available: Boolean(sourceCheckoutPath) }
    )
  }

  await emitScanEvent(
    scanId,
    "engine_output_parsed",
    "info",
    `Parsed ${output.findingCount} finding(s) from engine output`,
    {
      findingCount: output.findingCount,
      engineStatus: output.runRecord?.status ?? "unknown",
      outputAvailable: Boolean(outputDir),
    }
  )

  return {
    exitCode,
    cancelled,
    timedOut,
    timeoutReason,
    budgetKilled,
    output,
    sourceCheckoutPath,
    sourceRevision,
    sandboxRemoved,
  }
}

export interface EngineTriageRunResult {
  artifact: EngineTriageArtifact | null
  /** Bounded private usage receipt, normalized by the worker before accounting. */
  llmUsage?: Record<string, unknown>
  exitCode: number
  timedOut: boolean
  cancelled: boolean
}

function isTriageUsage(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Runs the engine-owned triage command in an existing scan workspace. The
 * command receives only redacted candidate data and has no repository target.
 */
export async function runEngineTriage(params: {
  scanId: string
  profile: EngineProfile
  input: Record<string, unknown>
  maxBudgetUsd: number
  timeoutMs: number
  shouldCancel?: () => Promise<boolean>
}): Promise<EngineTriageRunResult> {
  const { scanId, profile, input, maxBudgetUsd, timeoutMs, shouldCancel } = params
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) {
    throw new Error("Invalid scan id for triage workspace")
  }
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new Error("Triage requires a positive remaining scan budget")
  }

  const absWorkDir = resolve(ENGINE_WORK_ROOT, scanId)
  const inputPath = join(absWorkDir, "ai-security-triage-input.json")
  const outputPath = join(absWorkDir, "ai-security-triage.json")
  // inputPath is constrained to the worker-owned per-scan workspace above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(inputPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 })
  await rm(outputPath, { force: true })

  const processResult = await runEngineProcess(
    {
      executable: env.LYRASHIELD_ENGINE_PATH || "lyrashield",
      args: [
        "ai-security-triage",
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--enabled",
        "--max-budget-usd",
        String(maxBudgetUsd),
      ],
      workDir: absWorkDir,
    },
    absWorkDir,
    scanId,
    Math.min(timeoutMs, 90_000),
    profile,
    shouldCancel
  )

  let rawArtifact: unknown
  try {
    rawArtifact = JSON.parse(
      await readTextFileBounded(outputPath, MAX_ENGINE_TRIAGE_ARTIFACT_BYTES)
    )
  } catch (error) {
    logger.warn("AI security triage artifact unavailable or invalid JSON", {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { artifact: null, ...processResult }
  }
  const artifact = parseEngineTriageArtifact(rawArtifact)
  if (!artifact) {
    logger.warn("AI security triage artifact violated its versioned contract", { scanId })
    return { artifact: null, ...processResult }
  }
  const rawUsage = isTriageUsage(rawArtifact) ? rawArtifact.llmUsage : undefined
  return {
    artifact,
    ...(isTriageUsage(rawUsage) ? { llmUsage: rawUsage } : {}),
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled,
  }
}

export async function cleanupEngineWorkspace(workDir: string, runName?: string): Promise<void> {
  const targets: string[] = []
  const workspace = resolve(workDir)
  const workspaceFromRoot = relative(ENGINE_WORK_ROOT, workspace)
  if (
    workspaceFromRoot &&
    workspaceFromRoot !== ".." &&
    !workspaceFromRoot.startsWith(`..${sep}`)
  ) {
    targets.push(workspace)
  } else {
    logger.warn("Refusing to clean an engine workspace outside the owned run root", { workDir })
  }

  if (runName && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runName) && !runName.includes("..")) {
    const checkoutPrefix = `repo_${runName}_`
    try {
      // ENGINE_CHECKOUT_ROOT is a fixed worker-owned temporary directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const entry of await readdir(ENGINE_CHECKOUT_ROOT)) {
        if (!entry.startsWith(checkoutPrefix)) continue
        const checkoutDir = resolve(ENGINE_CHECKOUT_ROOT, entry)
        if (relative(ENGINE_CHECKOUT_ROOT, checkoutDir) !== entry) continue
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const checkoutStat = await lstat(checkoutDir)
        if (checkoutStat.isDirectory() && !checkoutStat.isSymbolicLink()) targets.push(checkoutDir)
      }
    } catch {
      // The engine may fail before cloning, so no checkout directory is normal.
    }
  }

  const failures: Error[] = []
  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)))
      logger.warn("Failed to clean up engine-owned files", {
        target,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to remove ${failures.length} engine workspace path(s)`
    )
  }
  logger.info("Engine workspace cleaned up", { workDir, removedPaths: targets.length })
}
