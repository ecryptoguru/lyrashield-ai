import type { AISecuritySignal, AISecurityTriage } from "./types"

export const ENGINE_TRIAGE_SCHEMA_VERSION = "ai-security-triage/1.0" as const

export type EngineTriageStatus = "COMPLETED" | "DISABLED" | "FAILED" | "BUDGET_STOPPED"

export type EngineTriageArtifact = {
  schemaVersion: typeof ENGINE_TRIAGE_SCHEMA_VERSION
  status: EngineTriageStatus
  terminalReason: string | null
  policyVersion: string
  modelRoute: string
  inputChecksum: string
  cacheKey: string
  redactionReceipt: {
    policyVersion: string
    inputChecksum: string
    redactedFieldCounts: Record<string, number>
    boundedExcerptBytes: number
  }
  results: Array<{
    // The deterministic evidence checksum is deliberately the only join key;
    // filenames, snippets, repositories, and targets never cross this boundary.
    findingIdentity: string
    disposition: AISecurityTriage["disposition"]
    confidence: number
    explanation: string
    evidenceChecksum: string
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

function isDisposition(value: unknown): value is AISecurityTriage["disposition"] {
  return value === "LIKELY_VALID" || value === "NEEDS_REVIEW" || value === "LIKELY_FALSE_POSITIVE"
}

/** Validates the engine artifact before its non-authoritative overlay is exposed. */
export function parseEngineTriageArtifact(value: unknown): EngineTriageArtifact | null {
  if (!isRecord(value) || value.schemaVersion !== ENGINE_TRIAGE_SCHEMA_VERSION) return null
  if (
    !["COMPLETED", "DISABLED", "FAILED", "BUDGET_STOPPED"].includes(String(value.status)) ||
    (value.terminalReason !== null && !isBoundedString(value.terminalReason, 128)) ||
    !isBoundedString(value.policyVersion, 128) ||
    !isBoundedString(value.modelRoute, 128) ||
    !isSha256(value.inputChecksum) ||
    !isSha256(value.cacheKey) ||
    !Array.isArray(value.results) ||
    value.results.length > 20 ||
    !isRecord(value.redactionReceipt)
  ) {
    return null
  }

  const receipt = value.redactionReceipt
  const boundedExcerptBytes = receipt.boundedExcerptBytes
  const redactedFieldCounts = receipt.redactedFieldCounts
  if (
    !isBoundedString(receipt.policyVersion, 128) ||
    !isSha256(receipt.inputChecksum) ||
    typeof boundedExcerptBytes !== "number" ||
    !Number.isInteger(boundedExcerptBytes) ||
    boundedExcerptBytes < 1 ||
    boundedExcerptBytes > 4096 ||
    !isRecord(redactedFieldCounts)
  ) {
    return null
  }
  if (
    Object.entries(redactedFieldCounts).some(
      ([key, count]) =>
        key.length > 64 ||
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > 10_000
    )
  ) {
    return null
  }

  const results: EngineTriageArtifact["results"] = []
  for (const result of value.results) {
    if (
      !isRecord(result) ||
      !isSha256(result.findingIdentity) ||
      !isDisposition(result.disposition) ||
      typeof result.confidence !== "number" ||
      !Number.isFinite(result.confidence) ||
      result.confidence < 0 ||
      result.confidence > 1 ||
      !isBoundedString(result.explanation, 800) ||
      !isSha256(result.evidenceChecksum) ||
      result.findingIdentity !== result.evidenceChecksum
    ) {
      return null
    }
    results.push({
      findingIdentity: result.findingIdentity,
      disposition: result.disposition,
      confidence: result.confidence,
      explanation: result.explanation,
      evidenceChecksum: result.evidenceChecksum,
    })
  }

  return {
    schemaVersion: ENGINE_TRIAGE_SCHEMA_VERSION,
    status: value.status as EngineTriageStatus,
    terminalReason: value.terminalReason as string | null,
    policyVersion: value.policyVersion,
    modelRoute: value.modelRoute,
    inputChecksum: value.inputChecksum,
    cacheKey: value.cacheKey,
    redactionReceipt: {
      policyVersion: receipt.policyVersion,
      inputChecksum: receipt.inputChecksum,
      redactedFieldCounts: redactedFieldCounts as Record<string, number>,
      boundedExcerptBytes,
    },
    results,
  }
}

/**
 * Applies the overlay only to matching detected signals. This intentionally
 * cannot change evidence state, severity, coverage, finding identity, or score.
 */
export function applyEngineTriageArtifact(
  signals: AISecuritySignal[],
  artifact: EngineTriageArtifact | null
): AISecuritySignal[] {
  if (!artifact || artifact.status !== "COMPLETED") return signals
  const results = new Map(artifact.results.map((result) => [result.evidenceChecksum, result]))
  return signals.map((signal) => {
    if (signal.state !== "DETECTED") return signal
    const result = results.get(signal.evidenceChecksum)
    if (!result) return signal
    return {
      ...signal,
      triage: {
        disposition: result.disposition,
        confidence: Math.round(result.confidence * 100),
        explanation: result.explanation,
        policyVersion: artifact.policyVersion,
        modelRoute: artifact.modelRoute,
        redactionReceipt: artifact.redactionReceipt.inputChecksum,
      },
    }
  })
}
