import { spawn, type ChildProcess } from "child_process"
import { rm, mkdir, readdir, stat, lstat, realpath, open } from "fs/promises"
import { join, relative, resolve, sep } from "path"
import { tmpdir } from "os"
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { buildEngineCommand, type ScanConfig, type EngineCommand } from "./command-builder"
import { parseEngineOutput, type ParsedScanOutput } from "./output-parser"

export interface EngineRunResult {
  exitCode: number
  cancelled: boolean
  timedOut: boolean
  output: ParsedScanOutput
  /** Validated host-side checkout for deterministic repository scanners. */
  sourceCheckoutPath: string | null
}

const DEFAULT_ENGINE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_DEEP_ENGINE_TIMEOUT_MS = 60 * 60 * 1000
const MAX_ENGINE_TIMEOUT_MS = 24 * 60 * 60 * 1000

export function resolveEngineTimeoutMs(mode: string, maxDurationMinutes?: number | null): number {
  if (
    typeof maxDurationMinutes !== "number" ||
    !Number.isFinite(maxDurationMinutes) ||
    maxDurationMinutes <= 0
  ) {
    return mode === "DEEP" || mode === "CUSTOM"
      ? DEFAULT_DEEP_ENGINE_TIMEOUT_MS
      : DEFAULT_ENGINE_TIMEOUT_MS
  }
  return Math.min(Math.floor(maxDurationMinutes * 60 * 1000), MAX_ENGINE_TIMEOUT_MS)
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
const SIGKILL_GRACE_MS = 5000
const ENGINE_HEARTBEAT_MS = 30_000
const MAX_ENGINE_ERROR_TAIL_BYTES = 4096
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

export interface EngineProfile {
  model?: string
  reasoningEffort: "medium"
  delegateModel?: string
  delegateReasoningEffort: "medium"
}

function assertSupportedRepositoryModel(model: string | undefined): void {
  const normalizedModel = model?.toLowerCase().replaceAll("_", "-")
  if (
    normalizedModel &&
    !/(?:^|[/.-])gpt-5\.6-(?:sol|terra|luna)(?:$|[/.-])/.test(normalizedModel)
  ) {
    throw new Error("LyraShield scans require a GPT-5.6 Sol, Terra, or Luna deployment")
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

  return {
    model,
    reasoningEffort: "medium",
    delegateModel,
    delegateReasoningEffort: "medium",
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
}

function requireRepositoryModel(model: string | undefined): string {
  if (!model) {
    throw new Error("A GPT-5.6 Sol, Terra, or Luna deployment must be configured")
  }
  return model
}

function buildEngineEnv(profile: EngineProfile): Record<string, string> {
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
    "LYRASHIELD_IMAGE",
    "LYRASHIELD_RUNTIME_BACKEND",
    "LYRASHIELD_MAX_LOCAL_COPY_MB",
    "LYRASHIELD_REASONING_EFFORT",
    "LYRASHIELD_TELEMETRY",
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
    if (value === undefined) continue
    if (allow.has(key)) {
      filtered[key] = value
    }
  }
  if (profile.model) filtered.LYRASHIELD_LLM = profile.model
  filtered.LYRASHIELD_REASONING_EFFORT = profile.reasoningEffort
  if (profile.delegateModel) filtered.LYRASHIELD_DELEGATE_LLM = profile.delegateModel
  filtered.LYRASHIELD_DELEGATE_REASONING_EFFORT = profile.delegateReasoningEffort
  filtered.STRIX_DOCKER_SANDBOX_NETWORK = resolveEngineSandboxNetwork()
  filtered.STRIX_SANDBOX_MEM_LIMIT = process.env.STRIX_SANDBOX_MEM_LIMIT?.trim() || "4g"
  filtered.STRIX_SANDBOX_CPUS = process.env.STRIX_SANDBOX_CPUS?.trim() || "2"
  filtered.STRIX_SANDBOX_PIDS_LIMIT = process.env.STRIX_SANDBOX_PIDS_LIMIT?.trim() || "512"
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
  timeoutMs: number,
  profile: EngineProfile,
  shouldCancel?: () => Promise<boolean>
): Promise<{
  exitCode: number
  timedOut: boolean
  cancelled: boolean
  failureType: string | null
}> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(cmd.executable, cmd.args, {
      cwd: absWorkDir,
      env: buildEngineEnv(profile),
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdoutBytes = 0
    let stderrBytes = 0
    let stderrTail = Buffer.alloc(0)
    let failureMarkerWindow = ""
    let failureType: string | null = null
    let timedOut = false
    let cancelled = false
    let closed = false
    let terminationRequested = false

    const escalation = createKillEscalation(child, SIGKILL_GRACE_MS)
    const terminate = () => {
      if (terminationRequested) return
      terminationRequested = true
      escalation.onTimeout()
    }
    const stopTracking = trackActiveEngineProcess(terminate)

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
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
    const heartbeatTimer = setInterval(() => {
      void emitScanEvent(scanId, "engine_activity", "info", "AI analysis is still running", {
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      })
    }, ENGINE_HEARTBEAT_MS)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-MAX_ENGINE_ERROR_TAIL_BYTES)
      const marker = collectEngineFailureType(failureMarkerWindow, chunk)
      failureMarkerWindow = marker.window
      failureType = marker.failureType ?? failureType
    })

    child.on("close", (code) => {
      closed = true
      clearTimeout(timer)
      clearInterval(heartbeatTimer)
      if (cancellationTimer) clearInterval(cancellationTimer)
      escalation.markExited()
      stopTracking()
      const exitCode = code ?? (timedOut || cancelled ? -1 : 1)
      logger.info("Engine streams consumed", { scanId, stdoutBytes, stderrBytes })
      resolvePromise({
        exitCode,
        timedOut,
        cancelled,
        failureType: failureType ?? extractEngineFailureType(stderrTail.toString("utf8")),
      })
    })

    child.on("error", (err) => {
      closed = true
      clearTimeout(timer)
      clearInterval(heartbeatTimer)
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
const ENGINE_CHECKOUT_ROOT = resolve(tmpdir(), "strix_repos")
const ENGINE_WORK_ROOT = resolve(process.cwd(), "lyrashield_runs")

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
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if ((await stat(checkout)).isDirectory()) return checkout
    } catch {
      // Missing checkouts are a coverage gap, not an empty source scan.
    }
  }

  return null
}

async function hasEngineOutputArtifact(runDir: string): Promise<boolean> {
  for (const artifact of ENGINE_OUTPUT_ARTIFACTS) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const artifactStat = await stat(join(runDir, artifact))
      if (artifactStat.isFile()) return true
    } catch {
      // Try the next expected artifact.
    }
  }
  return false
}

export async function findRunOutputDir(workDir: string): Promise<string | null> {
  let newest: { path: string; mtimeMs: number } | null = null
  let entriesSeen = 0

  for (const layout of ENGINE_RUN_LAYOUTS) {
    const runsDir = join(workDir, layout)
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const entry of await readdir(runsDir)) {
        if (++entriesSeen > MAX_RUN_OUTPUT_ENTRIES) {
          logger.warn("Engine run output walk capped", {
            workDir,
            maxEntries: MAX_RUN_OUTPUT_ENTRIES,
          })
          break
        }
        const entryPath = join(runsDir, entry)
        try {
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

async function readTextFileBounded(path: string, maxBytes: number): Promise<string> {
  // The artifact location is selected only from a validated engine output directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const handle = await open(path, "r")
  try {
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
  timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS,
  shouldCancel?: () => Promise<boolean>
): Promise<EngineRunResult> {
  const cmd = buildEngineCommand(config)
  const profile = resolveEngineProfile(config.mode)

  const absWorkDir = resolve(cmd.workDir)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(absWorkDir, { recursive: true })

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
      shouldCancel
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
      cancelled: false,
      failureType: null,
    }
  }
  const { exitCode, timedOut, cancelled, failureType } = processResult

  if (timedOut) {
    await emitScanEvent(
      scanId,
      "engine_timeout",
      "error",
      `Engine timed out after ${timeoutMs / 1000}s`,
      {
        timeoutMs,
      }
    )
    logger.error("Engine timed out", { scanId, timeoutMs })
  } else {
    await emitScanEvent(scanId, "engine_exit", "info", `Engine exited with code ${exitCode}`, {
      exitCode,
    })
  }

  logger.info("Engine process finished", {
    scanId,
    exitCode,
    timedOut,
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

  const outputDir = await findRunOutputDir(absWorkDir)
  const { vulnerabilitiesRaw, runJsonRaw } = outputDir
    ? await readEngineOutput(outputDir)
    : { vulnerabilitiesRaw: "", runJsonRaw: "" }

  const output = parseEngineOutput(vulnerabilitiesRaw, runJsonRaw)
  const sourceCheckoutPath = await resolveEngineSourceCheckout(output.runRecord)

  if (config.target.type === "REPO") {
    await emitScanEvent(
      scanId,
      "source_checkout",
      sourceCheckoutPath ? "info" : "warning",
      sourceCheckoutPath
        ? "Validated engine source checkout for deterministic scanners"
        : "Validated engine source checkout unavailable; deterministic repository scanners will be skipped",
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

  return { exitCode, cancelled, timedOut, output, sourceCheckoutPath }
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
    const checkoutRunDir = resolve(ENGINE_CHECKOUT_ROOT, runName)
    const checkoutFromRoot = relative(ENGINE_CHECKOUT_ROOT, checkoutRunDir)
    if (checkoutFromRoot && checkoutFromRoot !== ".." && !checkoutFromRoot.startsWith(`..${sep}`)) {
      targets.push(checkoutRunDir)
    }
  }

  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (err) {
      logger.warn("Failed to clean up engine-owned files", {
        workDir,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  logger.info("Engine workspace cleaned up", { workDir })
}
