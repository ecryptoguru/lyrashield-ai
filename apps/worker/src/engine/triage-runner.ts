import { rm, writeFile } from "fs/promises"
import { join, resolve } from "path"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import {
  ENGINE_TRIAGE_POLICY_VERSION,
  ENGINE_TRIAGE_SCHEMA_VERSION,
  parseEngineTriageArtifact,
  type EngineTriageArtifact,
} from "@lyrashield/security/ai-security"
import { getAiResultCacheRedis } from "@lyrashield/integrations"
import {
  AI_RESULT_CACHE_COMMAND_TIMEOUT_MS,
  createAiResultCache,
  createProcessSingleFlight,
  parseAiResultReuseReceipt,
  sha256CanonicalJson,
  type AiResultCacheDescriptor,
  type AiResultCacheLookup,
  type AiResultCacheMode,
  type AiResultCacheOperationMetrics,
  type AiResultReuseReceipt,
} from "./ai-result-cache"
import type { EngineProfile } from "./runner-config"
import { readTextFileBounded } from "./runner-output"
import { runEngineProcess } from "./runner-process"
import { ENGINE_WORK_ROOT } from "./workspace-path"

const MAX_ENGINE_TRIAGE_ARTIFACT_BYTES = 128 * 1024

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

function cancelledTriageResult(
  cacheOperations: AiResultCacheOperationMetrics
): EngineTriageRunResult {
  return {
    source: "provider",
    artifact: null,
    cacheOperations,
    exitCode: 0,
    timedOut: false,
    cancelled: true,
  }
}

type CachedOutcome = { early: EngineTriageRunResult } | { cacheLookup: AiResultCacheLookup | null }

async function resolveCachedOutcome(args: {
  resultCache: NonNullable<ReturnType<typeof getTriageResultCache>>
  descriptor: AiResultCacheDescriptor
  scanId: string
  remainingMs: () => number
  shouldCancel?: () => Promise<boolean>
  cancellationRequested: () => Promise<boolean>
  cacheMode: AiResultCacheMode
  cacheOperations: AiResultCacheOperationMetrics
  recordCacheOperation: (delta: AiResultCacheOperationMetrics) => void
}): Promise<CachedOutcome> {
  const {
    resultCache,
    descriptor,
    scanId,
    shouldCancel,
    cancellationRequested,
    cacheMode,
    cacheOperations,
    recordCacheOperation,
  } = args
  let cacheLookup: AiResultCacheLookup | null = null
  const lookupBudgetMs = Math.max(
    0,
    Math.min(AI_RESULT_CACHE_COMMAND_TIMEOUT_MS, args.remainingMs())
  )
  if (lookupBudgetMs > 0) {
    const lookupResult = await waitForCacheOperation(
      resultCache.lookup(descriptor, Date.now(), undefined, recordCacheOperation),
      lookupBudgetMs,
      shouldCancel
    )
    if (lookupResult.kind === "cancelled") {
      return { early: cancelledTriageResult(cacheOperations) }
    }
    if (lookupResult.kind === "timeout") {
      logger.warn("AI triage cache lookup reached its scan deadline", { scanId })
    } else if (lookupResult.kind === "value") {
      cacheLookup = lookupResult.value
    }
  }
  if (await cancellationRequested()) return { early: cancelledTriageResult(cacheOperations) }
  if (cacheMode === "enforce" && cacheLookup?.outcome === "hit" && cacheLookup.artifact) {
    logger.info("AI triage exact result reused", { scanId, source: "exact_cache" })
    return {
      early: {
        source: "exact_cache",
        artifact: cacheLookup.artifact,
        reuseReceipt: cacheLookup.reuseReceipt,
        cacheOperations,
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      },
    }
  }
  if (cacheMode === "observe" && cacheLookup?.outcome === "hit") {
    logger.info("AI triage exact cache opportunity observed", { scanId, outcome: "hit" })
  }
  return { cacheLookup }
}

type ParsedTriageArtifact =
  | { kind: "unreadable" }
  | { kind: "invalid-receipt" }
  | { kind: "reuse"; artifact: EngineTriageArtifact; reuseReceipt: AiResultReuseReceipt }
  | { kind: "missing"; rawUsage?: Record<string, unknown> }
  | { kind: "ok"; artifact: EngineTriageArtifact; rawUsage?: Record<string, unknown> }

async function readTriageArtifact(
  outputPath: string,
  scanId: string
): Promise<ParsedTriageArtifact> {
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
    return { kind: "unreadable" }
  }
  const rawUsage =
    isTriageUsage(rawArtifact) && isTriageUsage(rawArtifact.llmUsage)
      ? rawArtifact.llmUsage
      : undefined
  const rawReuseReceipt = isTriageUsage(rawArtifact) ? rawArtifact.reuseReceipt : undefined
  const artifact = parseEngineTriageArtifact(rawArtifact)
  if (rawReuseReceipt !== undefined) {
    const reuseReceipt = artifact ? parseAiResultReuseReceipt(rawReuseReceipt, artifact) : null
    if (!artifact || !reuseReceipt) {
      logger.warn("AI triage reuse receipt failed validation", { scanId })
      return { kind: "invalid-receipt" }
    }
    return { kind: "reuse", artifact, reuseReceipt }
  }
  if (!artifact) {
    logger.warn("AI security triage artifact violated its versioned contract", { scanId })
    return { kind: "missing", rawUsage }
  }
  return { kind: "ok", artifact, rawUsage }
}

async function storeTriageArtifact(args: {
  resultCache: NonNullable<ReturnType<typeof getTriageResultCache>> | null
  descriptor: AiResultCacheDescriptor | null
  artifact: EngineTriageArtifact
  rawUsage: Record<string, unknown> | undefined
  remainingMs: () => number
  cancellationRequested: () => Promise<boolean>
  shouldCancel?: () => Promise<boolean>
  recordCacheOperation: (delta: AiResultCacheOperationMetrics) => void
}): Promise<void> {
  const { resultCache, descriptor, artifact, rawUsage, shouldCancel, recordCacheOperation } = args
  if (!resultCache || !descriptor || !isTriageUsage(rawUsage)) return
  const storeBudgetMs = Math.max(
    0,
    Math.min(AI_RESULT_CACHE_COMMAND_TIMEOUT_MS, args.remainingMs())
  )
  if (storeBudgetMs > 0 && !(await args.cancellationRequested())) {
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
  const remainingMs = () => timeoutMs - (Date.now() - startedAt)
  const cancellationRequested = async () => {
    if (!shouldCancel) return false
    try {
      return await shouldCancel()
    } catch {
      return true
    }
  }
  if (await cancellationRequested()) return cancelledTriageResult(cacheOperations)

  const cached = resultCache
    ? await resolveCachedOutcome({
        resultCache,
        descriptor: descriptor as AiResultCacheDescriptor,
        scanId,
        remainingMs,
        shouldCancel,
        cancellationRequested,
        cacheMode,
        cacheOperations,
        recordCacheOperation,
      })
    : null
  if (cached && "early" in cached) return cached.early
  if (await cancellationRequested()) return cancelledTriageResult(cacheOperations)

  const absWorkDir = resolve(ENGINE_WORK_ROOT, scanId)
  const inputPath = join(absWorkDir, "ai-security-triage-input.json")
  const outputPath = join(absWorkDir, "ai-security-triage.json")
  // inputPath is constrained to the worker-owned per-scan workspace above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(inputPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 })
  await rm(outputPath, { force: true })

  const processTimeoutMs = Math.max(0, Math.min(remainingMs(), 90_000))
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

  const parsed = await readTriageArtifact(outputPath, scanId)
  if (parsed.kind === "unreadable") {
    return { source: "provider", artifact: null, cacheOperations, ...processResult }
  }
  if (parsed.kind === "invalid-receipt") {
    return {
      source: "provider",
      artifact: null,
      cacheOperations,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      cancelled: processResult.cancelled,
    }
  }
  if (parsed.kind === "reuse") {
    return {
      source: "exact_cache",
      artifact: parsed.artifact,
      reuseReceipt: parsed.reuseReceipt,
      cacheOperations,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      cancelled: processResult.cancelled,
    }
  }
  if (parsed.kind === "missing") {
    return {
      source: "provider",
      artifact: null,
      cacheOperations,
      ...(parsed.rawUsage ? { llmUsage: parsed.rawUsage } : {}),
      ...processResult,
    }
  }
  await storeTriageArtifact({
    resultCache,
    descriptor,
    artifact: parsed.artifact,
    rawUsage: parsed.rawUsage,
    remainingMs,
    cancellationRequested,
    shouldCancel,
    recordCacheOperation,
  })
  return {
    source: "provider",
    artifact: parsed.artifact,
    cacheOperations,
    ...(parsed.rawUsage ? { llmUsage: parsed.rawUsage } : {}),
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled,
  }
}
