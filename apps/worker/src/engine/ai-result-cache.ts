import { canonicalJson } from "@lyrashield/types"
import { aiResultCacheTargetIndexKey } from "@lyrashield/integrations"
import { createHash, createHmac } from "node:crypto"
import {
  ENGINE_TRIAGE_SCHEMA_VERSION,
  parseEngineTriageArtifact,
  type EngineTriageArtifact,
} from "@lyrashield/security/ai-security"

export const AI_RESULT_CACHE_TTL_SECONDS = 24 * 60 * 60
export const AI_RESULT_CACHE_MAX_BYTES = 128 * 1024
export const AI_RESULT_CACHE_COMMAND_TIMEOUT_MS = 500
export const AI_RESULT_CACHE_FAILURE_THRESHOLD = 3
export const AI_RESULT_CACHE_CIRCUIT_OPEN_MS = 60_000
const CACHE_KEY_PREFIX = "lyrashield:ai-cache:v1:triage:"
const CACHE_VALUE_VERSION = "ai-result-cache-entry/1.0"

export type AiResultCacheDescriptor = {
  workspaceId: string
  targetId: string
  sourceRevision: string
  inputChecksum: string
  evidenceChecksums: string[]
  engineRevision: string
  providerFingerprint: string
  modelSettings: {
    modelRoute: string
    reasoningEffort: string
    promptCachePolicy: "off"
    maxInputTokens: number
    maxOutputTokens: number
  }
  triagePolicyVersion: string
  schemaVersion: string
  effectiveLimits: {
    maxCalls: number
    maxConcurrency: number
    maxExcerptBytes: number
    maxInputTokens: number
    maxOutputTokens: number
    maxWallSeconds: number
    maxBudgetUsd: number
  }
}

export interface AiResultCacheRedis {
  status?: string
  connect?: () => Promise<unknown>
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    ttlSeconds: number,
    condition: "NX"
  ): Promise<unknown>
  multi(): AiResultCacheTransaction
  smembers(key: string): Promise<string[]>
  del(...keys: string[]): Promise<number>
}

export interface AiResultCacheTransaction {
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    ttlSeconds: number,
    condition: "NX"
  ): AiResultCacheTransaction
  sadd(key: string, member: string): AiResultCacheTransaction
  expire(key: string, ttlSeconds: number): AiResultCacheTransaction
  exec(): Promise<Array<[Error | null, unknown]> | null>
}

export type AiResultReuseReceipt = {
  version: "ai-result-reuse/1.0"
  artifactSha256: string
  createdAt: string
  expiresAt: string
  currentProviderRequests: 0
  currentProviderCostUsd: 0
}

export type AiResultCacheLookup = {
  outcome: "hit" | "miss" | "unavailable" | "disabled"
  artifact?: EngineTriageArtifact
  reuseReceipt?: AiResultReuseReceipt
}

export type AiResultCacheOperationMetrics = {
  readCommands: number
  writeCommands: number
  bytesRead: number
  bytesWritten: number
}
export type AiResultCacheOperationRecorder = (metrics: AiResultCacheOperationMetrics) => void

export type AiResultCacheMode = "off" | "observe" | "enforce"

export type SingleFlightResult<T> =
  | { shared: false; value: T }
  | { shared: true; value: T }
  | { shared: true; cancelled: true }
  | { shared: true; timedOut: true }

/** Process-local duplicate suppression; Redis remains a best-effort accelerator. */
export function createProcessSingleFlight<T>(maxConcurrentKeys = 256) {
  const flights = new Map<string, Promise<T>>()

  return {
    async run(
      key: string,
      work: () => Promise<T>,
      options: { timeoutMs: number; shouldCancel?: () => Promise<boolean> }
    ): Promise<SingleFlightResult<T>> {
      const existing = flights.get(key)
      if (existing) {
        const deadline = Date.now() + Math.max(1, options.timeoutMs)
        while (true) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) return { shared: true, timedOut: true }
          if (options.shouldCancel) {
            try {
              if (await options.shouldCancel()) return { shared: true, cancelled: true }
            } catch {
              return { shared: true, cancelled: true }
            }
          }
          let pollTimer: ReturnType<typeof setTimeout> | undefined
          const outcome = await Promise.race([
            existing.then(
              (value) => ({ kind: "value" as const, value }),
              (error: unknown) => ({ kind: "error" as const, error })
            ),
            new Promise<{ kind: "poll" }>((resolvePoll) => {
              pollTimer = setTimeout(() => resolvePoll({ kind: "poll" }), Math.min(200, remaining))
            }),
          ])
          if (pollTimer) clearTimeout(pollTimer)
          if (outcome.kind === "value") return { shared: true, value: outcome.value }
          if (outcome.kind === "error") throw outcome.error
        }
      }

      const pending = Promise.resolve().then(work)
      const canRegister = flights.size < maxConcurrentKeys
      if (canRegister) flights.set(key, pending)
      try {
        return { shared: false, value: await pending }
      } finally {
        if (canRegister && flights.get(key) === pending) flights.delete(key)
      }
    },
  }
}

type CacheEnvelope = {
  version: typeof CACHE_VALUE_VERSION
  descriptorHmac: string
  createdAt: string
  expiresAt: string
  artifactSha256: string
  artifact: EngineTriageArtifact
}

export function parseAiResultReuseReceipt(
  value: unknown,
  artifact: EngineTriageArtifact,
  now = Date.now()
): AiResultReuseReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const receipt = value as Record<string, unknown>
  const createdAtMs = Date.parse(String(receipt.createdAt ?? ""))
  const expiresAtMs = Date.parse(String(receipt.expiresAt ?? ""))
  if (
    receipt.version !== "ai-result-reuse/1.0" ||
    typeof receipt.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(receipt.artifactSha256) ||
    receipt.artifactSha256 !== sha256CanonicalJson(artifact) ||
    receipt.currentProviderRequests !== 0 ||
    receipt.currentProviderCostUsd !== 0 ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    createdAtMs > now ||
    expiresAtMs <= now ||
    expiresAtMs !== createdAtMs + AI_RESULT_CACHE_TTL_SECONDS * 1000
  ) {
    return null
  }
  return {
    version: "ai-result-reuse/1.0",
    artifactSha256: receipt.artifactSha256,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    currentProviderRequests: 0,
    currentProviderCostUsd: 0,
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256(canonicalJson(value))
}

function hasMinimumProvenance(descriptor: AiResultCacheDescriptor): boolean {
  const validIdentifier = (value: string) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f]/.test(value)
  const validSha = (value: string, length: number) =>
    typeof value === "string" && value.length === length && /^[a-f0-9]+$/i.test(value)
  return (
    validIdentifier(descriptor.workspaceId) &&
    validIdentifier(descriptor.targetId) &&
    validSha(descriptor.sourceRevision, 40) &&
    validSha(descriptor.inputChecksum, 64) &&
    descriptor.evidenceChecksums.length > 0 &&
    descriptor.evidenceChecksums.length <= 20 &&
    descriptor.evidenceChecksums.every((value) => validSha(value, 64)) &&
    validSha(descriptor.engineRevision, 40) &&
    validSha(descriptor.providerFingerprint, 64) &&
    validIdentifier(descriptor.modelSettings.modelRoute) &&
    descriptor.modelSettings.promptCachePolicy === "off" &&
    validIdentifier(descriptor.triagePolicyVersion) &&
    descriptor.schemaVersion === ENGINE_TRIAGE_SCHEMA_VERSION &&
    Number.isSafeInteger(descriptor.modelSettings.maxInputTokens) &&
    Number.isSafeInteger(descriptor.modelSettings.maxOutputTokens) &&
    Number.isSafeInteger(descriptor.effectiveLimits.maxCalls) &&
    Number.isSafeInteger(descriptor.effectiveLimits.maxConcurrency) &&
    Number.isSafeInteger(descriptor.effectiveLimits.maxExcerptBytes) &&
    Number.isSafeInteger(descriptor.effectiveLimits.maxInputTokens) &&
    Number.isSafeInteger(descriptor.effectiveLimits.maxOutputTokens) &&
    Number.isSafeInteger(descriptor.effectiveLimits.maxWallSeconds) &&
    Number.isFinite(descriptor.effectiveLimits.maxBudgetUsd) &&
    descriptor.effectiveLimits.maxBudgetUsd > 0
  )
}

function completeUsage(value: unknown, expectedModel: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  if (usage.accountingComplete !== true && usage.accounting_complete !== true) return false
  const entries = usage.request_usage_entries
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100) return false
  if (usage.requests !== entries.length) return false
  const modelBuckets = usage.model_usage_buckets
  if (
    modelBuckets !== undefined &&
    (!Array.isArray(modelBuckets) || modelBuckets.length === 0 || modelBuckets.length > 3)
  ) {
    return false
  }
  const totals = {
    standard_input_tokens: 0,
    standard_cached_input_tokens: 0,
    standard_cache_write_input_tokens: 0,
    standard_output_tokens: 0,
    long_input_tokens: 0,
    long_cached_input_tokens: 0,
    long_cache_write_input_tokens: 0,
    long_output_tokens: 0,
  }
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false
    const request = raw as Record<string, unknown>
    const details = request.input_tokens_details
    if (typeof details !== "object" || details === null || Array.isArray(details)) return false
    const input = request.input_tokens
    const output = request.output_tokens
    const cached = (details as Record<string, unknown>).cached_tokens
    const written = (details as Record<string, unknown>).cache_write_tokens
    const total = request.total_tokens
    if (
      request.model !== expectedModel ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      !Number.isSafeInteger(cached) ||
      !Number.isSafeInteger(written) ||
      !Number.isSafeInteger(total) ||
      Number(input) < 0 ||
      Number(output) < 0 ||
      Number(cached) < 0 ||
      Number(written) < 0 ||
      Number(total) !== Number(input) + Number(output) ||
      Number(cached) + Number(written) > Number(input)
    ) {
      return false
    }
    const bucketPrefix = Number(input) > 272_000 ? "long" : "standard"
    totals[`${bucketPrefix}_input_tokens` as keyof typeof totals] += Number(input)
    totals[`${bucketPrefix}_cached_input_tokens` as keyof typeof totals] += Number(cached)
    totals[`${bucketPrefix}_cache_write_input_tokens` as keyof typeof totals] += Number(written)
    totals[`${bucketPrefix}_output_tokens` as keyof typeof totals] += Number(output)
  }
  if (modelBuckets === undefined) return true
  if (modelBuckets.length !== 1) return false
  const bucket = modelBuckets[0]
  if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) return false
  const record = bucket as Record<string, unknown>
  return (
    record.model === expectedModel &&
    Object.entries(totals).every(
      ([key, expected]) => Number.isSafeInteger(record[key]) && record[key] === expected
    )
  )
}

function artifactMatchesDescriptor(
  artifact: EngineTriageArtifact,
  descriptor: AiResultCacheDescriptor
): boolean {
  const allowedEvidence = new Set(descriptor.evidenceChecksums)
  const identities = new Set<string>()
  return (
    artifact.status === "COMPLETED" &&
    artifact.schemaVersion === descriptor.schemaVersion &&
    artifact.policyVersion === descriptor.triagePolicyVersion &&
    artifact.modelRoute === descriptor.modelSettings.modelRoute &&
    artifact.inputChecksum === descriptor.inputChecksum &&
    artifact.redactionReceipt.inputChecksum === descriptor.inputChecksum &&
    artifact.results.every((result) => {
      if (
        result.findingIdentity !== result.evidenceChecksum ||
        !allowedEvidence.has(result.evidenceChecksum) ||
        identities.has(result.evidenceChecksum)
      ) {
        return false
      }
      identities.add(result.evidenceChecksum)
      return true
    })
  )
}

export function createAiResultCache(params: {
  redis: AiResultCacheRedis | (() => AiResultCacheRedis | null)
  secret: string
  mode: AiResultCacheMode
  logger?: (reason: string) => void
}) {
  let consecutiveFailures = 0
  let circuitOpenedUntil = 0

  const getRedis = () => (typeof params.redis === "function" ? params.redis() : params.redis)
  const reportFailure = (now: number, logger = params.logger) => {
    consecutiveFailures += 1
    if (consecutiveFailures >= AI_RESULT_CACHE_FAILURE_THRESHOLD) {
      circuitOpenedUntil = now + AI_RESULT_CACHE_CIRCUIT_OPEN_MS
    }
    logger?.("redis_error")
  }
  const recordOperation = (
    recorder: AiResultCacheOperationRecorder | undefined,
    metrics: AiResultCacheOperationMetrics
  ) => {
    try {
      recorder?.(metrics)
    } catch {
      // Telemetry must never change cache or scan behavior.
    }
  }
  const keyFor = (descriptor: AiResultCacheDescriptor) => {
    const digest = createHmac("sha256", params.secret)
      .update(canonicalJson(descriptor))
      .digest("hex")
    return { key: `${CACHE_KEY_PREFIX}${digest}`, digest }
  }
  const connect = async (redis: AiResultCacheRedis) => {
    if (redis.status === "wait" && redis.connect) await redis.connect()
  }

  return {
    async lookup(
      descriptor: AiResultCacheDescriptor,
      now = Date.now(),
      logger = params.logger,
      recorder?: AiResultCacheOperationRecorder
    ): Promise<AiResultCacheLookup> {
      if (
        params.mode === "off" ||
        Buffer.byteLength(params.secret, "utf8") < 32 ||
        !hasMinimumProvenance(descriptor)
      ) {
        return { outcome: "disabled" }
      }
      if (now < circuitOpenedUntil) return { outcome: "unavailable" }
      const redis = getRedis()
      if (!redis) return { outcome: "disabled" }
      const { key, digest } = keyFor(descriptor)
      try {
        await connect(redis)
        recordOperation(recorder, {
          readCommands: 1,
          writeCommands: 0,
          bytesRead: 0,
          bytesWritten: 0,
        })
        const raw = await redis.get(key)
        recordOperation(recorder, {
          readCommands: 0,
          writeCommands: 0,
          bytesRead: Buffer.byteLength(raw ?? "", "utf8"),
          bytesWritten: 0,
        })
        consecutiveFailures = 0
        if (!raw || Buffer.byteLength(raw, "utf8") > AI_RESULT_CACHE_MAX_BYTES) {
          return { outcome: "miss" }
        }
        let decoded: unknown
        try {
          decoded = JSON.parse(raw)
        } catch {
          return { outcome: "miss" }
        }
        if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
          return { outcome: "miss" }
        }
        const envelope = decoded as Partial<CacheEnvelope>
        const createdAt = Date.parse(String(envelope.createdAt ?? ""))
        const expiresAt = Date.parse(String(envelope.expiresAt ?? ""))
        if (
          envelope.version !== CACHE_VALUE_VERSION ||
          envelope.descriptorHmac !== digest ||
          !Number.isFinite(createdAt) ||
          !Number.isFinite(expiresAt) ||
          createdAt > now ||
          expiresAt <= now ||
          expiresAt !== createdAt + AI_RESULT_CACHE_TTL_SECONDS * 1000 ||
          typeof envelope.artifactSha256 !== "string" ||
          typeof envelope.artifact !== "object"
        ) {
          return { outcome: "miss" }
        }
        const artifact = parseEngineTriageArtifact(envelope.artifact)
        if (
          !artifact ||
          !artifactMatchesDescriptor(artifact, descriptor) ||
          sha256(canonicalJson(artifact)) !== envelope.artifactSha256
        ) {
          return { outcome: "miss" }
        }
        return {
          outcome: "hit",
          artifact,
          reuseReceipt: {
            version: "ai-result-reuse/1.0",
            artifactSha256: envelope.artifactSha256,
            createdAt: new Date(createdAt).toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            currentProviderRequests: 0,
            currentProviderCostUsd: 0,
          },
        }
      } catch {
        reportFailure(now, logger)
        return { outcome: "unavailable" }
      }
    },

    async store(
      descriptor: AiResultCacheDescriptor,
      rawArtifact: unknown,
      llmUsage: unknown,
      now = Date.now(),
      logger = params.logger,
      recorder?: AiResultCacheOperationRecorder
    ): Promise<boolean> {
      if (
        params.mode === "off" ||
        Buffer.byteLength(params.secret, "utf8") < 32 ||
        !hasMinimumProvenance(descriptor) ||
        !completeUsage(llmUsage, descriptor.modelSettings.modelRoute)
      ) {
        return false
      }
      const artifact = parseEngineTriageArtifact(rawArtifact)
      if (!artifact || !artifactMatchesDescriptor(artifact, descriptor)) return false
      if (now < circuitOpenedUntil) return false
      const redis = getRedis()
      if (!redis) return false
      const { key, digest } = keyFor(descriptor)
      // Keep only the already parsed overlay; transport data and historical usage
      // never enter the cache value. Replace the public artifact's unsalted key.
      const safeArtifact: EngineTriageArtifact = { ...artifact, cacheKey: digest }
      const createdAt = new Date(now).toISOString()
      const expiresAt = new Date(now + AI_RESULT_CACHE_TTL_SECONDS * 1000).toISOString()
      const envelope: CacheEnvelope = {
        version: CACHE_VALUE_VERSION,
        descriptorHmac: digest,
        createdAt,
        expiresAt,
        artifactSha256: sha256(canonicalJson(safeArtifact)),
        artifact: safeArtifact,
      }
      const serialized = canonicalJson(envelope)
      if (Buffer.byteLength(serialized, "utf8") > AI_RESULT_CACHE_MAX_BYTES) return false
      try {
        await connect(redis)
        // NX makes a valid entry's TTL absolute from its original creation.
        const targetIndexKey = aiResultCacheTargetIndexKey(
          params.secret,
          descriptor.workspaceId,
          descriptor.targetId
        )
        recordOperation(recorder, {
          readCommands: 0,
          writeCommands: 3,
          bytesRead: 0,
          bytesWritten: Buffer.byteLength(serialized, "utf8"),
        })
        const results = await redis
          .multi()
          .set(key, serialized, "EX", AI_RESULT_CACHE_TTL_SECONDS, "NX")
          .sadd(targetIndexKey, key)
          .expire(targetIndexKey, AI_RESULT_CACHE_TTL_SECONDS)
          .exec()
        if (!results || results.some(([error]) => error !== null)) {
          throw new Error("redis_transaction_failed")
        }
        consecutiveFailures = 0
        return results[0]?.[1] === "OK"
      } catch {
        reportFailure(now, logger)
        return false
      }
    },
  }
}
