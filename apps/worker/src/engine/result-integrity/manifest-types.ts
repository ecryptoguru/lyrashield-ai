import type { UrlExecutionSummary } from "@lyrashield/types"
import type { ParsedEngineCoverage } from "../output-parser"
import type { ScannerCoverageIssue, ScannerDiscovery } from "../scanner-coverage"
import type {
  AiAppSecurityDiscoveryReceipt,
  WebMcpCoverageReceipt,
} from "../scanners/ai-app-security"

type ResultTarget = {
  id: string
  type: string
  repoFullName?: string | null
  branch?: string | null
  url?: string | null
}

export type ResultManifestInput = {
  scanId: string
  target: ResultTarget
  /** True when the scan's tier runs the engine (REPO always; URL STANDARD/DEEP). */
  engineBacked?: boolean
  sourceCheckoutAvailable: boolean
  engineFindingCount: number
  coverageIssues: ScannerCoverageIssue[]
  /** Per-family discovery receipts — files scanned, bytes, bounded skips. */
  scannerDiscovery?: ScannerDiscovery
  aiAppSecurityDiscovery?: AiAppSecurityDiscoveryReceipt
  webMcpCoverage?: WebMcpCoverageReceipt | null
  matchedControlRanks?: number[]
  urlExecution?: UrlExecutionSummary
  sourceExecution?: { kind: "deterministic_retest"; sourceRevision: string }
  engineExecution?: {
    model?: string
    reasoningEffort?: string
    image: string | null
    imageDigest?: string
    engineVersion?: string
    promptBundleHash?: string
    delegateModel?: string
    delegateReasoningEffort?: string
    routingPolicy?: string
    compactionTriggerTokens?: number
    compactionTargetTokens?: number
    maxOutputTokens?: number
    maxAgents?: number
    sourceRevision?: string
    sandboxRemoved?: boolean
  }
  accounting?: {
    maxBudgetUsd: number
    billedCostUsd: number | null
    reconciled: boolean
    reconciliationReason?: string
  }
  workerExecution?: {
    productRevision: string
    workerImageDigest: string
    engineRevision: string
  } | null
  terminalOutcome?: {
    status: "COMPLETED" | "PARTIAL" | "FAILED" | "STOPPED_BUDGET"
    errorCategory: string | null
    errorMessage: string | null
  }
  /**
   * run.json 1.1: model-declared scoped coverage (coverage.json). Entries map
   * into namespaced receipt rows (`engine-scope:*`/`engine-gap:*`) and are
   * never read as deterministic control outcomes.
   */
  scopedCoverage?: ParsedEngineCoverage | null
  /**
   * Checksum-bound reference to the scan's threat-model artifact in encrypted
   * evidence storage. The artifact is a declared model — never proof that the
   * attack paths it names were exercised.
   */
  threatModel?: {
    checksum: string
    byteLength: number
    modelCount: number
    schemaVersion?: string
    /** Bounded engine-declared preview for truthful rendering — the sealed
     * artifact stays authoritative; never treated as verification. */
    entries?: { target: string; preview: string }[]
  } | null
  /**
   * Checksum-bound reference to the scan's bounded redacted proxy-exchange
   * index (http_exchanges.json) in encrypted evidence storage.
   */
  httpExchangeEvidence?: {
    checksum: string
    byteLength: number
    exchangeCount: number
    schemaVersion?: string
  } | null
  /**
   * Checksum-bound receipt for the plan's staged attachments: how many input
   * files were verified and staged read-only, their aggregate bytes, and the
   * sha256 of the manifest the engine consumed. Absent when the plan had no
   * attachments or the tier never staged them.
   */
  attachments?: {
    count: number
    totalBytes: number
    manifestChecksum: string
  } | null
  /** Bounded explicit issues recorded while ingesting engine evidence. */
  ingestionWarnings?: string[]
}
export const MANIFEST_VERSION = 7
export const SCANNER_CONTRACT_VERSION = "2026-09-13a"

type CoverageStatus = "COMPLETED" | "NOT_APPLICABLE" | "BLOCKED" | "PARTIAL"

export type FamilyReceipt = {
  scanner: string
  controlId: string
  status: CoverageStatus
  reason?: string
  subject?: string
  metadata: Record<string, unknown>
}
