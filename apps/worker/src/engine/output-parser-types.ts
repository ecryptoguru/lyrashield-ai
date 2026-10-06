/**
 * dependency_metadata is a bounded flat provenance record that may also carry
 * structured contextual-CVSS members (advisory score, contextual score,
 * vector, per-metric breakdown, reasoning). Values stay shallow: short
 * strings, finite numbers, booleans, or a one-level string map — deep JSON
 * never survives the worker boundary.
 */
export type EngineMetadataValue = string | number | boolean | Record<string, string>

/**
 * Structured advisory CVSS (upstream `{score, vector, source,
 * metric_reasoning}`). The advisory score is evidence about the dependency,
 * never the finding's normalized CVSS.
 */
export interface AdvisoryCvss {
  score: number
  vector?: string
  source?: string
  metric_reasoning?: string
}

/**
 * fix_verification — an ENGINE ATTESTATION that the filing agent ran a fix
 * check (`kind: "engine_attestation"`). It is evidence, never a verification
 * receipt and never proof that a fix works.
 */
export interface FixVerificationAttestation {
  kind?: string
  statement: string
  method?: string
  evidence_refs?: string[]
}

/** Append-only engine revision attribution for a finding. */
export interface FindingRevision {
  timestamp: string
  fields: string[]
  dropped_fields?: string[]
  reason?: string
  agent_id?: string
  agent_name?: string
  previous_severity?: string
  previous_cvss?: number
  previous_confidence?: string
}

export interface EngineVulnerability {
  id: string
  title: string
  severity: string
  timestamp: string
  target?: string
  endpoint?: string
  method?: string
  cve?: string
  cwe?: string
  cvss?: number
  cvss_breakdown?: Record<string, string>
  description?: string
  impact?: string
  technical_analysis?: string
  evidence?: string
  assumptions?: string
  fix_effort?: "trivial" | "low" | "medium" | "high"
  finding_class?: string
  dependency_metadata?: Record<string, EngineMetadataValue>
  poc_description?: string
  poc_script_code?: string
  remediation_steps?: string
  control_ids?: number[]
  // ── run.json 1.1 evidence fields ──────────────────────────────────────────
  // All of these are engine-asserted evidence. The engine's own `verified`
  // claim is deliberately NOT part of this interface: it is untrusted input
  // and is dropped at the boundary. App verification only ever comes from
  // FindingVerification receipts written by trusted paths.
  counterevidence?: string
  /** Engine-declared confidence (wire field `confidence`); evidence only. */
  engine_confidence?: "high" | "medium" | "low"
  confidence_rationale?: string
  severity_change_conditions?: string
  /** Engine attestation object — never a verification receipt. */
  fix_verification?: FixVerificationAttestation
  contextual_cvss_reasoning?: string
  advisory_cvss?: AdvisoryCvss
  /**
   * Proxy exchange ids the finding cites. Only present when the ids survived
   * both shape validation and (when an exchange export is available) the
   * current-scan exchange index; they are evidence references, never a
   * verification receipt.
   */
  http_exchange_ids?: string[]
  /**
   * True when the engine declared exchange references that were dropped during
   * ingestion (unknown ids, or the exchange export was unavailable). The flag
   * keeps the dropped-evidence warning durable beside the finding.
   */
  http_exchange_refs_dropped?: boolean
  update_history?: FindingRevision[]
  updated_at?: string
  /** Engine-recorded per-finding ingestion warnings. */
  evidence_warnings?: string[]
  /** Upstream evidence-schema stamp ("1.1") — provenance only. */
  evidence_contract_version?: string
  /**
   * The engine's declared verification_state verbatim (wire field
   * `verification_state`). Engine-asserted evidence — it can never become the
   * app's verification status.
   */
  engine_verification_state?: string
  code_locations?: Array<{
    file?: string
    start_line?: number
    end_line?: number
    label?: string
    snippet?: string
    fix_before?: string
    fix_after?: string
  }>
  agent_id?: string
  agent_name?: string
  /** Internal detector provenance, attached by the orchestrator after parsing. */
  scannerSource?:
    | "engine"
    | "sca"
    | "secrets"
    | "url"
    | "agent_config"
    | "ai_app_security"
    | "ml_supply_chain"
    | "sast"
    | "iac"
    | "external_import"
  /** Every detector that independently produced the normalized finding. */
  corroboratingSources?: Array<
    | "engine"
    | "sca"
    | "secrets"
    | "url"
    | "agent_config"
    | "ai_app_security"
    | "ml_supply_chain"
    | "sast"
    | "iac"
    | "external_import"
  >
}

export interface EngineRunRecord {
  schema_version?: string
  run_id: string
  run_name: string | null
  start_time: string
  end_time: string | null
  status: string
  targets_info?: unknown[]
  llm_usage?: Record<string, unknown>
  webSearchCostUsd?: number
  scan_results?: Record<string, unknown>
  engine_version?: string
  prompt_bundle_hash?: string
  prompt_cache?: {
    enabled: boolean
    routing_enabled: boolean
    routing: "stable-prompt-v2" | null
    mode: "explicit" | "implicit" | null
    ttl: "30m" | null
  }
  model?: string
  reasoning_effort?: string
  delegate_model?: string
  delegate_reasoning_effort?: string
  model_routing_policy?: string
  compaction_trigger_tokens?: number
  compaction_target_tokens?: number
  max_output_tokens?: number
  max_agents?: number
  cleanup?: { sandbox_removed: boolean }
  scan_mode?: string
  terminal_reason?: string
  /** run.json 1.1: monotonic revision of the run's report artifacts. */
  report_artifacts_revision?: number
  /** run.json 1.1: the engine's exchange-export outcome (evidence status). */
  evidence_export?: {
    status?: "exported" | "partial" | "skipped" | "failed"
    reason?: string
    exchanges?: number
    missing_request_ids?: string[]
  }
}

/** Agent-reported coverage outcome from coverage.json (upstream VALID_OUTCOMES). */
export type ScopedCoverageOutcome =
  "reported" | "no_issue_found" | "ruled_out" | "not_applicable" | "needs_follow_up"

/**
 * One model-declared scoped coverage entry. `subject` is the surface the
 * agent says it looked at; `outcome` is its declared close reason; neither is
 * a deterministic control outcome.
 */
export interface ScopedCoverageEntry {
  id: string
  subject: string
  outcome: ScopedCoverageOutcome
  reason?: string
  evidenceRefs?: string[]
  recordedBy?: string
  recordedAt?: string
  updatedAt?: string
  previousOutcomes?: string[]
}

/** A coverage gap the engine's runtime or agents declared unexamined. */
export interface EngineCoverageGap {
  kind: string
  subject?: string
  detail: string
}

export interface ParsedEngineCoverage {
  schemaVersion?: string
  entries: ScopedCoverageEntry[]
  gaps: EngineCoverageGap[]
  completeness?: { complete: boolean; caveats: string[] }
}

export interface ParsedThreatModelEntry {
  target: string
  writtenAt?: string
  writtenBy?: string
  content: string
  amendments?: Array<{ at?: string; by?: string; content: string }>
}

export interface ParsedThreatModels {
  schemaVersion?: string
  models: ParsedThreatModelEntry[]
  /** Canonical bounded JSON persisted to encrypted artifact storage. */
  document: string
}

export interface ParsedHttpExchangeExport {
  schemaVersion?: string
  exchangeCount: number
  /** The exchange ids the scan's proxy export attests for this run. */
  knownIds: Set<string>
  /** Canonical bounded JSON persisted to encrypted artifact storage. */
  document: string
}

/**
 * Optional run.json 1.1 sibling artifacts, read bounded by the runner.
 * `undefined` means the artifact is absent; `null` means it existed but
 * failed the bounded read (oversized or unreadable) — an explicit ingestion
 * issue rather than a silently missing artifact.
 */
export interface EngineArtifactInput {
  coverageRaw?: string | null
  threatModelsRaw?: string | null
  httpExchangesRaw?: string | null
}

export interface ParsedScanOutput {
  vulnerabilities: EngineVulnerability[]
  runRecord: EngineRunRecord | null
  summary: string
  findingCount: number
  /** False when the engine did not provide a valid findings artifact. */
  findingsComplete: boolean
  /**
   * Explicit evidence-ingestion issues — malformed or unverifiable evidence
   * that was dropped rather than silently trusted. Bounded.
   */
  ingestionIssues: string[]
  /** Model-declared scoped coverage (coverage.json), never control outcomes. */
  scopedCoverage: ParsedEngineCoverage | null
  /** Versioned scan-bound threat model document (threat_model.json). */
  threatModels: ParsedThreatModels | null
  /** The scan's bounded proxy-exchange export (http_exchanges.json). */
  httpExchangeExport: ParsedHttpExchangeExport | null
}
