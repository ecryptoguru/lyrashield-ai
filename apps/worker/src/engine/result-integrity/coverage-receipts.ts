import { VIBE_SECURITY_CONTROLS, VIBE_SECURITY_COVERAGE_VERSION } from "@lyrashield/security"
import { scopedCoverageReceipts, type ScannerCoverageIssue } from "../scanner-coverage"
import type { FamilyReceipt, ResultManifestInput } from "./manifest-types"

const CONTROL_SCANNERS: Readonly<Record<number, readonly string[]>> = {
  1: ["engine"],
  2: ["engine"],
  10: ["engine", "sast"],
  3: ["secrets", "url", "iac"],
  14: ["url"],
  20: ["engine"],
  27: ["url"],
  28: ["url"],
  29: ["url", "sast"],
  30: ["engine", "url", "iac"],
  31: ["url"],
  32: ["url"],
  33: ["engine", "ai_app_security"],
  37: ["sca"],
  38: ["sca", "engine", "iac"],
  39: ["sca", "engine", "ml_supply_chain"],
  40: ["engine", "ai_app_security"],
  42: ["engine", "ai_app_security"],
  44: ["engine", "ai_app_security", "iac"],
  45: ["agent_config"],
  47: ["agent_config", "engine"],
}
export function receiptIdentityCoverageIssues(input: ResultManifestInput): ScannerCoverageIssue[] {
  if (
    input.target.type !== "REPO" ||
    (input.sourceExecution?.kind === "deterministic_retest" &&
      /^[a-f0-9]{40}$/i.test(input.sourceExecution.sourceRevision)) ||
    input.coverageIssues.some((issue) => issue.scanner === "engine")
  ) {
    return []
  }

  const execution = input.engineExecution
  const missing: string[] = []
  const requireValue = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === "") missing.push(name)
  }
  requireValue("engineExecution", execution)
  if (execution) {
    requireValue("model", execution.model)
    requireValue("reasoningEffort", execution.reasoningEffort)
    requireValue("imageDigest", execution.imageDigest)
    requireValue("engineVersion", execution.engineVersion)
    requireValue("promptBundleHash", execution.promptBundleHash)
    requireValue("delegateModel", execution.delegateModel)
    requireValue("delegateReasoningEffort", execution.delegateReasoningEffort)
    requireValue("routingPolicy", execution.routingPolicy)
    requireValue("compactionTriggerTokens", execution.compactionTriggerTokens)
    requireValue("compactionTargetTokens", execution.compactionTargetTokens)
    requireValue("maxOutputTokens", execution.maxOutputTokens)
    requireValue("maxAgents", execution.maxAgents)
    requireValue("sourceRevision", execution.sourceRevision)
    if (execution.sandboxRemoved !== true) missing.push("sandboxRemoved")
    if (execution.imageDigest && !/^sha256:[a-f0-9]{64}$/i.test(execution.imageDigest)) {
      missing.push("imageDigest(exact sha256)")
    }
  }
  requireValue("accounting", input.accounting)
  if (input.accounting) {
    if (!input.accounting.reconciled) missing.push("accounting.reconciled")
    requireValue("accounting.billedCostUsd", input.accounting.billedCostUsd)
  }

  return missing.length === 0
    ? []
    : [
        {
          scanner: "engine",
          status: "partial",
          subject: "result-manifest",
          reason: `Immutable repository receipt identity is incomplete: ${missing.join(", ")}`,
        },
      ]
}

function scannerStatus(
  scanner: string,
  applicable: boolean,
  coverageIssues: ScannerCoverageIssue[]
): {
  status: "COMPLETED" | "NOT_APPLICABLE" | "BLOCKED"
  reason?: string
  subject?: string
  metadata?: { issues: ScannerCoverageIssue[] }
} {
  if (!applicable) return { status: "NOT_APPLICABLE", reason: "Not applicable to this target" }
  const issues = coverageIssues
    .filter((candidate) => candidate.scanner === scanner)
    .sort((left, right) =>
      `${left.subject ?? ""}\u0000${left.status}\u0000${left.reason}`.localeCompare(
        `${right.subject ?? ""}\u0000${right.status}\u0000${right.reason}`
      )
    )
  if (issues.length > 0) {
    const reasons = [...new Set(issues.map((issue) => issue.reason))]
    const subjects = [...new Set(issues.flatMap((issue) => (issue.subject ? [issue.subject] : [])))]
    return {
      status: "BLOCKED",
      reason: reasons.join("; "),
      ...(subjects.length > 0 ? { subject: subjects.join(", ") } : {}),
      metadata: { issues },
    }
  }
  return { status: "COMPLETED" }
}

export function buildCoverageReceipts(input: ResultManifestInput) {
  const repositoryTarget = input.target.type === "REPO"
  const engineApplicable = repositoryTarget || input.engineBacked === true
  const engineStatus =
    input.sourceExecution?.kind === "deterministic_retest"
      ? {
          status: "NOT_APPLICABLE" as const,
          reason: "Model analysis was intentionally outside this deterministic retest scope.",
          metadata: { outcome: "NOT_ASSESSED" },
        }
      : !engineApplicable
        ? {
            status: "NOT_APPLICABLE" as const,
            reason: "Deterministic-only tier — the engine is part of STANDARD and DEEP reviews.",
            metadata: { outcome: "NOT_ASSESSED" },
          }
        : scannerStatus("engine", true, input.coverageIssues)
  const urlStatus = scannerStatus("url", Boolean(input.target.url), input.coverageIssues)
  const familyReceipts: FamilyReceipt[] = [
    {
      scanner: "engine",
      controlId: "engine",
      ...engineStatus,
      metadata: {
        findingCount: input.engineFindingCount,
        ...engineStatus.metadata,
      },
    },
    ...["sca", "secrets", "agent_config", "ml_supply_chain", "ai_app_security", "sast", "iac"].map(
      (scanner) => {
        const status = scannerStatus(
          scanner,
          repositoryTarget && input.sourceCheckoutAvailable,
          input.coverageIssues
        )
        return {
          scanner,
          controlId: scanner,
          ...status,
          metadata: {
            sourceCheckoutAvailable: input.sourceCheckoutAvailable,
            discovery: input.scannerDiscovery?.[scanner] ?? null,
            ...(scanner === "ai_app_security"
              ? {
                  discovery: input.aiAppSecurityDiscovery ?? null,
                  webMcpCoverage: input.webMcpCoverage ?? null,
                }
              : {}),
            ...status.metadata,
          },
        }
      }
    ),
    {
      scanner: "url",
      controlId: "url",
      ...urlStatus,
      metadata: {
        configured: Boolean(input.target.url),
        execution: input.urlExecution ?? null,
        ...urlStatus.metadata,
      },
    },
  ]

  const matchedRanks = new Set(input.matchedControlRanks ?? [])
  const familyByScanner = new Map(familyReceipts.map((receipt) => [receipt.scanner, receipt]))
  const controlReceipts: FamilyReceipt[] = VIBE_SECURITY_CONTROLS.map((control) => {
    const controlId = `vibe-${String(control.rank).padStart(2, "0")}`
    const scanners =
      CONTROL_SCANNERS[control.rank] ?? (control.strategy === "engine" ? ["engine"] : [])
    const applicableReceipts = scanners
      .map((scanner) => familyByScanner.get(scanner))
      .filter((receipt): receipt is FamilyReceipt => Boolean(receipt))
    const metadata = {
      rank: control.rank,
      title: control.title,
      strategy: control.strategy,
      scanners,
      coverageVersion: VIBE_SECURITY_COVERAGE_VERSION,
    }

    if (control.strategy === "evidence") {
      return {
        scanner: "evidence",
        controlId,
        status: "BLOCKED",
        reason: "Requires deployment, operational, or accountable human evidence.",
        metadata: { ...metadata, outcome: "EVIDENCE_REQUIRED" },
      }
    }

    if (
      applicableReceipts.length === 0 ||
      applicableReceipts.every((receipt) => receipt.status === "NOT_APPLICABLE")
    ) {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "NOT_APPLICABLE",
        reason: "No applicable scanner ran for this target type.",
        metadata: { ...metadata, outcome: "NOT_APPLICABLE" },
      }
    }

    if (matchedRanks.has(control.rank)) {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "COMPLETED",
        reason: "One or more findings were mapped to this control.",
        metadata: { ...metadata, outcome: "DETECTED" },
      }
    }

    const limitedReceipts = applicableReceipts.filter(
      (receipt) => receipt.status !== "COMPLETED" && receipt.status !== "NOT_APPLICABLE"
    )
    if (limitedReceipts.length > 0) {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "BLOCKED",
        reason: `Applicable coverage was limited: ${limitedReceipts
          .map((receipt) => receipt.reason ?? receipt.status)
          .join("; ")}`,
        metadata: { ...metadata, outcome: "INCONCLUSIVE" },
      }
    }

    if (control.strategy === "engine" || control.strategy === "hybrid") {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "BLOCKED",
        reason:
          control.strategy === "hybrid"
            ? "Available signals did not establish an evidence-backed outcome; absence is inconclusive."
            : "The model completed without an explicit control mapping; absence is inconclusive.",
        metadata: { ...metadata, outcome: "INCONCLUSIVE" },
      }
    }

    return {
      scanner: scanners.join("+") || control.strategy,
      controlId,
      status: "COMPLETED",
      reason:
        "No finding was returned by the completed applicable scanner. This is not independent verification.",
      metadata: { ...metadata, outcome: "NO_FINDING" },
    }
  })

  // run.json 1.1: engine-declared scoped coverage becomes namespaced receipt
  // rows (engine-scope:*/engine-gap:*). They are append-only declarations —
  // they never join familyReceipts or controlReceipts and can never mark a
  // deterministic outcome.
  const scopedReceipts: FamilyReceipt[] = input.scopedCoverage
    ? scopedCoverageReceipts(input.scopedCoverage.entries, input.scopedCoverage.gaps)
    : []

  return [...familyReceipts, ...controlReceipts, ...scopedReceipts]
}
