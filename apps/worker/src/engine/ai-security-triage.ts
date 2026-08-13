import type { AISecuritySignal } from "@lyrashield/security/ai-security"

const SHA256 = /^[a-f0-9]{64}$/i
const GIT_SHA = /^[a-f0-9]{40}$/i

export type EngineTriageInput = {
  schemaVersion: "ai-security-triage-input/1.0"
  commitSha: string
  detectorVersion: string
  ruleVersion: string
  candidates: Array<{
    findingIdentity: string
    controlId: string
    ruleId: string
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
    selectionReason: "MEDIUM_CONFIDENCE"
    evidenceChecksum: string
    evidenceExcerpt: string
  }>
}

/**
 * Select only medium-severity bounded snippets. The deterministic engine has
 * no confidence scalar yet, so this is the narrowest truthful initial cohort.
 */
export function buildEngineTriageInput(
  signals: AISecuritySignal[],
  sourceRevision: string | null | undefined
): EngineTriageInput | null {
  if (!sourceRevision || !GIT_SHA.test(sourceRevision)) return null
  const candidates = signals
    .filter(
      (signal) =>
        signal.state === "DETECTED" &&
        signal.severity === "MEDIUM" &&
        SHA256.test(signal.evidenceChecksum) &&
        Boolean(signal.snippet?.trim())
    )
    .sort((left, right) => left.evidenceChecksum.localeCompare(right.evidenceChecksum))
    .filter(
      (signal, index, all) =>
        index === 0 || signal.evidenceChecksum !== all[index - 1]?.evidenceChecksum
    )
    .slice(0, 20)
    .map((signal) => ({
      // The checksum is the only identity sent to the engine; no source path
      // or repository coordinate crosses this boundary.
      findingIdentity: signal.evidenceChecksum,
      controlId: signal.controlId,
      ruleId: signal.ruleId,
      severity: signal.severity,
      selectionReason: "MEDIUM_CONFIDENCE" as const,
      evidenceChecksum: signal.evidenceChecksum,
      evidenceExcerpt: Buffer.from(signal.snippet ?? "", "utf8")
        .subarray(0, 4096)
        .toString("utf8"),
    }))
  if (candidates.length === 0) return null
  return {
    schemaVersion: "ai-security-triage-input/1.0",
    commitSha: sourceRevision,
    detectorVersion: signals[0]?.detectorVersion ?? "ai-app-security/unknown",
    ruleVersion: "ai-app-security-rules/2026-08-13.1",
    candidates,
  }
}

export function eligibleForEngineTriage(params: {
  enabled: boolean
  workspacePlan: string
  mode: string
  billedCostUsd: number | null
  costReconciled: boolean
  maxBudgetUsd: number
  triageCapUsd: number
}): { eligible: boolean; reason: string; maxBudgetUsd?: number } {
  if (!params.enabled) return { eligible: false, reason: "TRIAGE_DISABLED" }
  if (params.workspacePlan === "FREE") return { eligible: false, reason: "PAID_PLAN_REQUIRED" }
  if (!["STANDARD", "DEEP"].includes(params.mode.toUpperCase())) {
    return { eligible: false, reason: "STANDARD_OR_DEEP_REQUIRED" }
  }
  if (!params.costReconciled || params.billedCostUsd === null) {
    return { eligible: false, reason: "TRIAGE_ACCOUNTING_UNAVAILABLE" }
  }
  const remaining = params.maxBudgetUsd - params.billedCostUsd
  const maxBudgetUsd = Math.min(remaining, params.triageCapUsd)
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    return { eligible: false, reason: "TRIAGE_BUDGET_EXHAUSTED" }
  }
  return { eligible: true, reason: "ELIGIBLE", maxBudgetUsd }
}
