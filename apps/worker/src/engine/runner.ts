import { rm, writeFile } from "fs/promises"
import { join, resolve } from "path"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import {
  ENGINE_TRIAGE_SCHEMA_VERSION,
  ENGINE_TRIAGE_POLICY_VERSION,
  parseEngineTriageArtifact,
  type EngineTriageArtifact,
} from "@lyrashield/security/ai-security"
import { getAiResultCacheRedis } from "@lyrashield/integrations"
import { buildEngineCommand, type ScanConfig } from "./command-builder"
import { parseEngineOutput, type ParsedScanOutput } from "./output-parser"
import { resolveEngineProfile, type EngineProfile } from "./runner-config"
import { emitScanEvent } from "./runner-events"
import {
  findRunOutputDir,
  prepareEngineWorkspace,
  readEngineOutput,
  readEngineProgressFingerprint,
  readEngineSpendUsd,
  readTextFileBounded,
  resolveEngineSourceCheckout,
  resolveEngineSourceRevision,
  verifySandboxRemoved,
} from "./runner-output"
import { ENGINE_LLM_STALL_MS, runEngineProcess } from "./runner-process"
import { ENGINE_WORK_ROOT } from "./workspace-path"
import {
  AI_RESULT_CACHE_COMMAND_TIMEOUT_MS,
  createAiResultCache,
  createProcessSingleFlight,
  parseAiResultReuseReceipt,
  sha256CanonicalJson,
  type AiResultCacheDescriptor,
  type AiResultCacheOperationMetrics,
  type AiResultReuseReceipt,
} from "./ai-result-cache"

export type { EngineProfile } from "./runner-config"
export {
  assertRepositoryScanRuntimeConfigured,
  buildEngineEnv,
  resolveEngineProfile,
  resolveEngineSandboxNetwork,
} from "./runner-config"
export {
  cleanupEngineWorkspace,
  findRunOutputDir,
  parseEngineProgressFingerprint,
  prepareEngineWorkspace,
  readEngineOutput,
  readEngineProgressFingerprint,
  readEngineSpendUsd,
  resolveEngineSourceCheckout,
  resolveEngineSourceRevision,
} from "./runner-output"
export {
  collectEngineFailureType,
  createKillEscalation,
  extractEngineFailureType,
  OVERSHOOT_GRACE,
  terminateActiveEngineProcesses,
  trackActiveEngineProcess,
} from "./runner-process"
export {
  appendEngineStreamTail,
  createEngineStreamTail,
  ENGINE_TAIL_MAX_CHARS,
  ENGINE_TAIL_MAX_LINES,
  flushEngineStreamTail,
  redactEngineTailLine,
} from "./runner-tail"

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
const MAX_ENGINE_TRIAGE_ARTIFACT_BYTES = 128 * 1024
const STRIX_RUN_TYPES: Record<string, string> = {
  REPO: "repository",
  WEB_APP: "web_application",
  API: "api_spec",
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

  const cmd = buildEngineCommand(config, timeoutMs)
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
      onAgentLoopTick,
      config.relay,
      STRIX_RUN_TYPES[config.target.type] ?? "repository"
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
  const { vulnerabilitiesRaw, runJsonRaw, artifacts } = outputDir
    ? await readEngineOutput(outputDir)
    : { vulnerabilitiesRaw: "", runJsonRaw: "", artifacts: {} }

  const output = parseEngineOutput(vulnerabilitiesRaw, runJsonRaw, artifacts)
  const sourceCheckoutPath = await resolveEngineSourceCheckout(output.runRecord, scanId)
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

interface EngineTriageRunResult {
  source: "provider" | "exact_cache" | "singleflight"
  artifact: EngineTriageArtifact | null
  /** Bounded private usage receipt, normalized by the worker before accounting. */
  llmUsage?: Record<string, unknown>
  /** Validated evidence that this invocation made no provider request. */
  reuseReceipt?: AiResultReuseReceipt
  cacheOperations?: AiResultCacheOperationMetrics
  exitCode: number
  timedOut: boolean
  cancelled: boolean
}

type CacheWaitResult<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "unavailable" }

async function waitForCacheOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  shouldCancel?: () => Promise<boolean>
): Promise<CacheWaitResult<T>> {
  const settled = operation.then(
    (value) => ({ kind: "value" as const, value }),
    () => ({ kind: "unavailable" as const })
  )
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (true) {
    if (shouldCancel) {
      try {
        if (await shouldCancel()) return { kind: "cancelled" }
      } catch {
        return { kind: "cancelled" }
      }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return { kind: "timeout" }
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = new Promise<{ kind: "tick" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "tick" }), Math.min(50, remainingMs))
    })
    let result: Awaited<typeof settled> | { kind: "tick" }
    try {
      result = await Promise.race([settled, tick])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (result.kind !== "tick") return result
  }
}

function emptyAiResultCacheOperationMetrics(): AiResultCacheOperationMetrics {
  return { readCommands: 0, writeCommands: 0, bytesRead: 0, bytesWritten: 0 }
}

export type EngineTriageRunParams = {
  scanId: string
  workspaceId: string
  targetId: string
  profile: EngineProfile
  input: Record<string, unknown>
  maxBudgetUsd: number
  timeoutMs: number
  shouldCancel?: () => Promise<boolean>
}

function isTriageUsage(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

let triageResultCache: ReturnType<typeof createAiResultCache> | null = null
const triageSingleFlight = createProcessSingleFlight<EngineTriageRunResult>()

function getTriageResultCache() {
  if (triageResultCache) return triageResultCache
  triageResultCache = createAiResultCache({
    redis: getAiResultCacheRedis,
    secret: env.LYRASHIELD_AI_CACHE_KEY_SECRET ?? "",
    mode: env.LYRASHIELD_AI_RESULT_CACHE_MODE,
    logger: (reason) => logger.warn("AI triage result cache unavailable", { reason }),
  })
  return triageResultCache
}

function buildTriageCacheDescriptor(params: {
  workspaceId: string
  targetId: string
  profile: EngineProfile
  input: Record<string, unknown>
  maxBudgetUsd: number
}): AiResultCacheDescriptor | null {
  const { workspaceId, targetId, profile, input, maxBudgetUsd } = params
  const commitSha = input.commitSha
  const candidates = input.candidates
  if (
    typeof commitSha !== "string" ||
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    candidates.some(
      (candidate) =>
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate) ||
        typeof (candidate as Record<string, unknown>).evidenceChecksum !== "string"
    )
  ) {
    return null
  }
  const evidenceChecksums = candidates.map(
    (candidate) => (candidate as Record<string, unknown>).evidenceChecksum as string
  )
  if (new Set(evidenceChecksums).size !== evidenceChecksums.length) return null
  const modelRoute = profile.model?.trim()
  if (!modelRoute) return null
  return {
    workspaceId,
    targetId,
    sourceRevision: commitSha,
    inputChecksum: sha256CanonicalJson(input),
    evidenceChecksums,
    engineRevision: env.LYRASHIELD_ENGINE_REVISION ?? "",
    providerFingerprint: env.LYRASHIELD_AI_CACHE_PROVIDER_FINGERPRINT ?? "",
    modelSettings: {
      modelRoute,
      reasoningEffort: "medium",
      promptCachePolicy: "off",
      maxInputTokens: 12_000,
      maxOutputTokens: 400,
    },
    triagePolicyVersion: ENGINE_TRIAGE_POLICY_VERSION,
    schemaVersion: ENGINE_TRIAGE_SCHEMA_VERSION,
    effectiveLimits: {
      maxCalls: 20,
      maxConcurrency: 2,
      maxExcerptBytes: 4096,
      maxInputTokens: 12_000,
      maxOutputTokens: 400,
      maxWallSeconds: 90,
      maxBudgetUsd,
    },
  }
}

/**
 * Runs the engine-owned triage command in an existing scan workspace. The
 * command receives only redacted candidate data and has no repository target.
 */
export async function runEngineTriage(
  params: EngineTriageRunParams
): Promise<EngineTriageRunResult> {
  const descriptor = buildTriageCacheDescriptor(params)
  if (env.LYRASHIELD_AI_RESULT_CACHE_MODE === "off" || !descriptor) {
    return runEngineTriageAttempt(params)
  }
  const result = await triageSingleFlight.run(
    sha256CanonicalJson(descriptor),
    () => runEngineTriageAttempt(params),
    { timeoutMs: params.timeoutMs, shouldCancel: params.shouldCancel }
  )
  if (!result.shared) return result.value
  if ("cancelled" in result) {
    return {
      source: "provider",
      artifact: null,
      cacheOperations: emptyAiResultCacheOperationMetrics(),
      exitCode: 0,
      timedOut: false,
      cancelled: true,
    }
  }
  if ("timedOut" in result) {
    return {
      source: "provider",
      artifact: null,
      cacheOperations: emptyAiResultCacheOperationMetrics(),
      exitCode: 0,
      timedOut: true,
      cancelled: false,
    }
  }
  return {
    source: result.value.source === "exact_cache" ? "exact_cache" : "singleflight",
    artifact: result.value.artifact,
    ...(result.value.source === "exact_cache" && result.value.reuseReceipt
      ? { reuseReceipt: result.value.reuseReceipt }
      : {}),
    cacheOperations: emptyAiResultCacheOperationMetrics(),
    exitCode: result.value.exitCode,
    timedOut: result.value.timedOut,
    cancelled: result.value.cancelled,
  }
}

async function runEngineTriageAttempt(
  params: EngineTriageRunParams
): Promise<EngineTriageRunResult> {
  const { scanId, workspaceId, targetId, profile, input, maxBudgetUsd, timeoutMs, shouldCancel } =
    params
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) {
    throw new Error("Invalid scan id for triage workspace")
  }
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new Error("Triage requires a positive remaining scan budget")
  }

  const descriptor = buildTriageCacheDescriptor({
    workspaceId,
    targetId,
    profile,
    input,
    maxBudgetUsd,
  })
  const cacheMode = env.LYRASHIELD_AI_RESULT_CACHE_MODE
  const resultCache = cacheMode === "off" || !descriptor ? null : getTriageResultCache()
  const cacheOperations = emptyAiResultCacheOperationMetrics()
  const recordCacheOperation = (delta: AiResultCacheOperationMetrics) => {
    cacheOperations.readCommands += delta.readCommands
    cacheOperations.writeCommands += delta.writeCommands
    cacheOperations.bytesRead += delta.bytesRead
    cacheOperations.bytesWritten += delta.bytesWritten
  }
  const startedAt = Date.now()
  const cancellationRequested = async () => {
    if (!shouldCancel) return false
    try {
      return await shouldCancel()
    } catch {
      return true
    }
  }
  if (await cancellationRequested()) {
    return {
      source: "provider",
      artifact: null,
      cacheOperations,
      exitCode: 0,
      timedOut: false,
      cancelled: true,
    }
  }
  let cacheLookup: Awaited<ReturnType<NonNullable<typeof resultCache>["lookup"]>> | null = null
  if (resultCache && descriptor) {
    const lookupBudgetMs = Math.max(
      0,
      Math.min(AI_RESULT_CACHE_COMMAND_TIMEOUT_MS, timeoutMs - (Date.now() - startedAt))
    )
    if (lookupBudgetMs > 0) {
      const lookupResult = await waitForCacheOperation(
        resultCache.lookup(descriptor, Date.now(), undefined, recordCacheOperation),
        lookupBudgetMs,
        shouldCancel
      )
      if (lookupResult.kind === "cancelled") {
        return {
          source: "provider",
          artifact: null,
          cacheOperations,
          exitCode: 0,
          timedOut: false,
          cancelled: true,
        }
      }
      if (lookupResult.kind === "timeout") {
        logger.warn("AI triage cache lookup reached its scan deadline", { scanId })
      } else if (lookupResult.kind === "value") {
        cacheLookup = lookupResult.value
      }
    }
  }
  if (await cancellationRequested()) {
    return {
      source: "provider",
      artifact: null,
      cacheOperations,
      exitCode: 0,
      timedOut: false,
      cancelled: true,
    }
  }
  if (cacheMode === "enforce" && cacheLookup?.outcome === "hit" && cacheLookup.artifact) {
    logger.info("AI triage exact result reused", { scanId, source: "exact_cache" })
    return {
      source: "exact_cache",
      artifact: cacheLookup.artifact,
      reuseReceipt: cacheLookup.reuseReceipt,
      cacheOperations,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    }
  }
  if (cacheMode === "observe" && cacheLookup?.outcome === "hit") {
    logger.info("AI triage exact cache opportunity observed", { scanId, outcome: "hit" })
  }

  const absWorkDir = resolve(ENGINE_WORK_ROOT, scanId)
  const inputPath = join(absWorkDir, "ai-security-triage-input.json")
  const outputPath = join(absWorkDir, "ai-security-triage.json")
  const cacheDir = join(absWorkDir, "ai-security-triage-cache")
  // inputPath is constrained to the worker-owned per-scan workspace above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(inputPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 })
  await rm(outputPath, { force: true })

  const processTimeoutMs = Math.max(0, Math.min(timeoutMs - (Date.now() - startedAt), 90_000))
  if (processTimeoutMs <= 0) {
    return {
      source: "provider",
      artifact: null,
      cacheOperations,
      exitCode: 0,
      timedOut: true,
      cancelled: false,
    }
  }
  const processResult = await runEngineProcess(
    {
      executable: env.LYRASHIELD_ENGINE_PATH || "lyrashield",
      args: [
        "ai-security-triage",
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--cache-dir",
        cacheDir,
        "--enabled",
        "--max-budget-usd",
        String(maxBudgetUsd),
      ],
      workDir: absWorkDir,
    },
    absWorkDir,
    scanId,
    processTimeoutMs,
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
    return { source: "provider", artifact: null, cacheOperations, ...processResult }
  }
  const rawUsage = isTriageUsage(rawArtifact) ? rawArtifact.llmUsage : undefined
  const rawReuseReceipt = isTriageUsage(rawArtifact) ? rawArtifact.reuseReceipt : undefined
  const artifact = parseEngineTriageArtifact(rawArtifact)
  if (rawReuseReceipt !== undefined) {
    const reuseReceipt = artifact ? parseAiResultReuseReceipt(rawReuseReceipt, artifact) : null
    if (!artifact || !reuseReceipt) {
      logger.warn("AI triage reuse receipt failed validation", { scanId })
      return {
        source: "provider",
        artifact: null,
        cacheOperations,
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
        cancelled: processResult.cancelled,
      }
    }
    return {
      source: "exact_cache",
      artifact,
      reuseReceipt,
      cacheOperations,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      cancelled: processResult.cancelled,
    }
  }
  if (!artifact) {
    logger.warn("AI security triage artifact violated its versioned contract", { scanId })
    return {
      source: "provider",
      artifact: null,
      cacheOperations,
      ...(isTriageUsage(rawUsage) ? { llmUsage: rawUsage } : {}),
      ...processResult,
    }
  }
  if (resultCache && descriptor && isTriageUsage(rawUsage)) {
    const storeBudgetMs = Math.max(
      0,
      Math.min(AI_RESULT_CACHE_COMMAND_TIMEOUT_MS, timeoutMs - (Date.now() - startedAt))
    )
    if (storeBudgetMs > 0 && !(await cancellationRequested())) {
      await waitForCacheOperation(
        resultCache.store(
          descriptor,
          artifact,
          rawUsage,
          Date.now(),
          undefined,
          recordCacheOperation
        ),
        storeBudgetMs,
        shouldCancel
      )
    }
  }
  return {
    source: "provider",
    artifact,
    cacheOperations,
    ...(isTriageUsage(rawUsage) ? { llmUsage: rawUsage } : {}),
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled,
  }
}
