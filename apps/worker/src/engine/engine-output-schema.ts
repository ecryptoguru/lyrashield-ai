import { z } from "zod"

const nonEmptyString = z
  .string()
  .min(1)
  .max(64 * 1024)
const boundedString = z
  .string()
  .max(64 * 1024)
  .optional()
const nullableBoundedString = z
  .string()
  .max(64 * 1024)
  .nullable()
  .optional()

// ── run.json 1.1 evidence bounds ────────────────────────────────────────────
// These mirror the engine writer limits (Strix 1.6.x report contract) so a
// finding carrying oversized or unbounded evidence fails validation instead of
// being silently truncated into durable storage.
export const MAX_HTTP_EXCHANGE_IDS = 10
export const MAX_HTTP_EXCHANGE_ID_CHARS = 128
export const MAX_FINDING_REVISIONS = 50
export const MAX_REVISION_FIELD_LIST = 64
// Matches upstream MAX_UPDATE_REASON_CHARS — a revision reason is a bounded
// attribution line, not prose.
export const MAX_REVISION_STRING_CHARS = 500
// Matches upstream COVERAGE_ENTRY_LIMIT — the writer truncates at 500, so a
// larger reader bound would only accept contract violations.
export const MAX_SCOPED_COVERAGE_ENTRIES = 500
export const MAX_COVERAGE_GAPS = 50
export const MAX_COVERAGE_PREVIOUS_OUTCOMES = 40
export const MAX_COVERAGE_STRING_CHARS = 4096
export const MAX_THREAT_MODELS = 20
export const MAX_THREAT_MODEL_AMENDMENTS = 40
export const MAX_THREAT_MODEL_CONTENT_CHARS = 64_000
export const MAX_THREAT_MODEL_AMENDMENT_CHARS = 8_000
export const MAX_HTTP_EXCHANGE_ENTRIES = 500
// Reader-side slack over the writer's 4096-byte decoded body-sample budget —
// redaction can alter length slightly, but an 8 KiB cap keeps a hostile
// artifact from inflating durable evidence.
export const MAX_HTTP_EXCHANGE_BODY_CHARS = 8 * 1024
export const MAX_METADATA_ENTRIES = 32
export const MAX_METADATA_VALUE_CHARS = 4096
export const MAX_METADATA_NESTED_ENTRIES = 16
export const MAX_METADATA_NESTED_VALUE_CHARS = 1024
export const MAX_INGESTION_ISSUES = 100
export const MAX_INGESTION_ISSUE_CHARS = 500
// Matches upstream MAX_EVIDENCE_FIELD_CHARS — the 1.1 evidence text fields are
// bounded at 10K by the writer; the reader keeps the same bound rather than
// admitting text the writer contract would never emit.
export const MAX_EVIDENCE_FIELD_CHARS = 10_000
// Matches upstream MAX_METRIC_REASONING_CHARS for advisory_cvss reasoning.
export const MAX_METRIC_REASONING_CHARS = 4_000

const severitySchema = z
  .string()
  .min(1)
  .refine((value) => ["critical", "high", "medium", "low", "info"].includes(value.toLowerCase()), {
    message: "Invalid severity value",
  })

const fixEffortSchema = z.enum(["trivial", "low", "medium", "high"]).optional()

const codeLocationSchema = z
  .object({
    file: boundedString,
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
    label: boundedString,
    snippet: boundedString,
    fix_before: boundedString,
    fix_after: boundedString,
  })
  .strip()

/**
 * Engine-declared confidence is evidence about the finding, never the app's
 * verification state. The wire field is `confidence`; the parsed property is
 * `engine_confidence` so nothing downstream can mistake it for the app-owned
 * `Finding.confidence` column.
 */
export const engineConfidenceSchema = z.enum(["high", "medium", "low"])

/**
 * Structured advisory CVSS (upstream `{score, vector, source,
 * metric_reasoning}`). The wire may carry a bare advisory score (number) or
 * the structured object; both normalize to this shape so vector and metric
 * reasoning survive ingestion rather than collapsing to a number.
 */
export const advisoryCvssSchema = z
  .object({
    score: z.number().min(0).max(10),
    vector: z
      .string()
      .max(256)
      // Same contract as the upstream _CVSS_VECTOR_RE, expressed without a
      // nested-quantifier regex: "CVSS:3.1/AV:N/AC:L/..." metric segments.
      .refine((value) => {
        const segments = value.split("/")
        if (!/^CVSS:[34]\.\d$/.test(segments[0] ?? "")) return false
        return segments.slice(1).every((segment) => /^[A-Z]{1,3}:[NLHARCUPM]$/.test(segment))
      }, "advisory_cvss.vector must be a CVSS vector")
      .optional(),
    source: z.string().max(256).optional(),
    metric_reasoning: z.string().max(MAX_METRIC_REASONING_CHARS).optional(),
  })
  .strip()

/**
 * fix_verification is an ENGINE ATTESTATION of what the filing agent checked —
 * upstream always stores `{kind: "engine_attestation", statement, method?,
 * evidence_refs?}` and a bare statement string normalizes into that object.
 * It is never a verification receipt and never proof a fix works.
 */
export const fixVerificationSchema = z
  .object({
    kind: z.string().max(64).optional(),
    statement: z.string().min(1).max(MAX_EVIDENCE_FIELD_CHARS),
    method: z.string().max(256).optional(),
    evidence_refs: z
      .array(z.string().min(1).max(MAX_HTTP_EXCHANGE_ID_CHARS))
      .max(MAX_HTTP_EXCHANGE_IDS)
      .optional(),
  })
  .strip()

/**
 * Append-only change attribution for a finding revision. Entries validate the
 * same creation-time invariants as the writer: a timestamp, the changed field
 * list, optional dropped fields, and previous-value attribution when the
 * revision moved severity/conclusion.
 */
export const findingRevisionSchema = z
  .object({
    timestamp: nonEmptyString,
    fields: z.array(z.string().min(1).max(128)).min(1).max(MAX_REVISION_FIELD_LIST),
    dropped_fields: z.array(z.string().min(1).max(128)).max(MAX_REVISION_FIELD_LIST).optional(),
    reason: z.string().max(MAX_REVISION_STRING_CHARS).optional(),
    agent_id: boundedString,
    agent_name: boundedString,
    previous_severity: boundedString,
    previous_cvss: z.number().min(0).max(10).optional(),
    previous_confidence: boundedString,
  })
  .strip()

/** Numeric-ASCII proxy request id, ≤128 chars (upstream `_MAX_HTTP_EXCHANGE_ID_CHARS`). */
export const httpExchangeIdSchema = z
  .string()
  .regex(/^[0-9]{1,128}$/, "http_exchange_ids entries must be numeric ASCII ids")

/**
 * dependency_metadata carries flat provenance strings plus structured
 * contextual-CVSS members (score, vector, per-metric breakdown, advisory
 * score). Values are bounded: short strings, finite numbers, booleans, or a
 * one-level string→string map for metric breakdowns — never deep JSON.
 */
export const engineMetadataValueSchema = z.union([
  z.string().max(MAX_METADATA_VALUE_CHARS),
  z.number().finite(),
  z.boolean(),
  z.record(z.string().max(64), z.string().max(MAX_METADATA_NESTED_VALUE_CHARS)),
])

export const engineVulnerabilitySchema = z
  .object({
    id: nonEmptyString,
    title: nonEmptyString,
    severity: severitySchema,
    timestamp: nonEmptyString,
    target: boundedString,
    endpoint: boundedString,
    method: boundedString,
    cve: boundedString,
    cwe: z
      .string()
      .max(64 * 1024)
      .regex(/^CWE-\d+$/, "CWE must be CWE-NNN")
      .optional(),
    cvss: z.number().min(0).max(10).optional(),
    cvss_breakdown: z.record(z.string(), z.string().max(64 * 1024)).optional(),
    description: boundedString,
    impact: boundedString,
    technical_analysis: boundedString,
    evidence: boundedString,
    assumptions: boundedString,
    fix_effort: fixEffortSchema,
    finding_class: boundedString,
    dependency_metadata: z.record(z.string(), engineMetadataValueSchema).optional(),
    poc_description: boundedString,
    poc_script_code: boundedString,
    remediation_steps: boundedString,
    control_ids: z.array(z.number().int().min(1).max(50)).max(50).optional(),
    code_locations: z.array(codeLocationSchema).max(100).optional(),
    agent_id: boundedString,
    agent_name: boundedString,
    // ── run.json 1.1 additive evidence fields ──────────────────────────────
    // Every field below is engine-asserted evidence, bounded at the writer's
    // own 10K/4K limits. None of it is a verification receipt: an engine
    // `verified` claim is never declared here and must never survive parsing.
    counterevidence: z.string().max(MAX_EVIDENCE_FIELD_CHARS).optional(),
    engine_confidence: engineConfidenceSchema.optional(),
    confidence_rationale: z.string().max(MAX_EVIDENCE_FIELD_CHARS).optional(),
    severity_change_conditions: z.string().max(MAX_EVIDENCE_FIELD_CHARS).optional(),
    fix_verification: fixVerificationSchema.optional(),
    contextual_cvss_reasoning: z.string().max(MAX_EVIDENCE_FIELD_CHARS).optional(),
    advisory_cvss: advisoryCvssSchema.optional(),
    http_exchange_ids: z.array(httpExchangeIdSchema).max(MAX_HTTP_EXCHANGE_IDS).optional(),
    /**
     * Set when the engine declared exchange references that could not be
     * verified against this scan's exported exchange evidence (unknown id, or
     * export unavailable). The dropped refs are never persisted as verified.
     */
    http_exchange_refs_dropped: z.boolean().optional(),
    update_history: z.array(findingRevisionSchema).max(MAX_FINDING_REVISIONS).optional(),
    updated_at: z.string().max(MAX_EVIDENCE_FIELD_CHARS).optional(),
    /** Engine-recorded per-finding ingestion warnings (upstream ≤10). */
    evidence_warnings: z.array(z.string().max(MAX_EVIDENCE_FIELD_CHARS)).max(10).optional(),
    /** Upstream stamps "1.1" on evidence-schema findings. */
    evidence_contract_version: z.string().max(64).optional(),
    /**
     * The engine's declared verification_state (default "unverified") is
     * engine-asserted evidence carried verbatim — it can never become the
     * app's verification status.
     */
    engine_verification_state: z.string().max(64).optional(),
  })
  .strip()

// ── run.json 1.1 sibling artifacts ──────────────────────────────────────────
// coverage.json, threat_models.json, and http_exchanges.json live next to
// run.json in the engine run directory. Each is a bounded, separately
// versioned document; none is trusted as a control outcome.

const scopedCoverageOutcomeSchema = z.enum([
  "reported",
  "no_issue_found",
  "ruled_out",
  "not_applicable",
  "needs_follow_up",
])

/**
 * One scoped-coverage ledger row. The engine's coverage document renders the
 * substrate fields (surface, risk_area, outcome, outcome_label, evidence,
 * recorded_by/at, updated_at, previous_outcomes, source) and overlays the
 * worker-facing contract fields (id, subject, investigation_status, reason,
 * evidence_refs). Both spellings are accepted so the reader tolerates
 * substrate-only documents.
 */
const scopedCoverageEntrySchema = z
  .object({
    id: z.string().max(128).optional(),
    entry_id: z.string().max(128).optional(),
    surface: z.string().max(MAX_COVERAGE_STRING_CHARS).optional(),
    subject: z.string().max(MAX_COVERAGE_STRING_CHARS).optional(),
    risk_area: z.string().max(MAX_COVERAGE_STRING_CHARS).optional(),
    outcome: scopedCoverageOutcomeSchema,
    investigation_status: scopedCoverageOutcomeSchema.optional(),
    outcome_label: boundedString,
    evidence: z.string().max(MAX_COVERAGE_STRING_CHARS).optional(),
    reason: z.string().max(MAX_COVERAGE_STRING_CHARS).optional(),
    recorded_by: boundedString,
    recorded_at: boundedString,
    updated_at: boundedString,
    previous_outcomes: z.array(z.string().max(64)).max(MAX_COVERAGE_PREVIOUS_OUTCOMES).optional(),
    source: boundedString,
    evidence_refs: z
      .array(z.string().min(1).max(MAX_HTTP_EXCHANGE_ID_CHARS))
      .max(MAX_HTTP_EXCHANGE_IDS)
      .optional(),
  })
  .strip()

const coverageGapSchema = z
  .object({
    kind: z.string().min(1).max(128),
    surface: z.string().max(MAX_COVERAGE_STRING_CHARS).optional(),
    risk_area: z.string().max(MAX_COVERAGE_STRING_CHARS).optional(),
    agent_name: boundedString,
    detail: z.string().min(1).max(MAX_COVERAGE_STRING_CHARS),
  })
  .strip()

/**
 * coverage.json — the engine's scoped coverage ledger. `entries` are
 * agent-reported coverage declarations; `gaps` are runtime-observed or
 * agent-declared holes. Both are model/runtime-declared input and map into
 * namespaced receipts, never into deterministic control outcomes. Entries and
 * gaps validate individually in the parser so one malformed row does not
 * discard the whole artifact.
 */
export const engineCoverageDocumentSchema = z
  .object({
    schema_version: z.union([z.number().int().min(0), z.string().max(64)]).optional(),
    generated_at: boundedString,
    run_id: boundedString,
    summary: z
      .object({
        surfaces_reviewed: z.number().int().min(0).optional(),
        findings_filed: z.number().int().min(0).optional(),
        gaps: z.number().int().min(0).optional(),
      })
      .strip()
      .optional(),
    completeness: z
      .object({
        complete: z.boolean(),
        caveats: z.array(z.string().max(MAX_COVERAGE_STRING_CHARS)).max(20).optional(),
      })
      .strip()
      .optional(),
    // Hard DoS bounds here; the parser truncates at the contract limits and
    // records an issue rather than dropping the whole artifact on overflow.
    entries: z
      .array(z.unknown())
      .max(MAX_SCOPED_COVERAGE_ENTRIES * 4)
      .optional(),
    gaps: z
      .array(z.unknown())
      .max(MAX_COVERAGE_GAPS * 4)
      .optional(),
    truncated: z
      .object({
        entries_dropped: z.number().int().min(0).optional(),
        entry_limit: z.number().int().min(0).optional(),
      })
      .strip()
      .optional(),
  })
  .strip()

export { scopedCoverageEntrySchema, coverageGapSchema }

const threatModelAmendmentSchema = z
  .object({
    at: boundedString,
    by: boundedString,
    content: z.string().max(MAX_THREAT_MODEL_AMENDMENT_CHARS),
  })
  .strip()

export const threatModelEntrySchema = z
  .object({
    target: z.string().min(1).max(1024),
    written_at: boundedString,
    written_by: boundedString,
    content: z.string().max(MAX_THREAT_MODEL_CONTENT_CHARS),
    amendments: z.array(threatModelAmendmentSchema).max(MAX_THREAT_MODEL_AMENDMENTS).optional(),
  })
  .strip()

/**
 * Canonical threat_model.json is the owned engine's versioned models array.
 * Older plural fixtures used an upstream target-keyed record; they remain an
 * explicitly named reader adapter, never a substitute for the owned writer.
 */
export const threatModelsDocumentSchema = z.union([
  z
    .object({
      schema_version: z.literal("lyrashield-threat-model/1.0"),
      generated_at: boundedString,
      run_id: boundedString,
      run_name: boundedString.optional(),
      models: z.array(threatModelEntrySchema).max(MAX_THREAT_MODELS),
      note: boundedString.optional(),
      truncated: z.boolean().optional(),
      error: boundedString.optional(),
    })
    .strip(),
  z.record(z.string().max(1024), threatModelEntrySchema),
  z
    .object({
      schema_version: z.union([z.number().int().min(0), z.string().max(64)]).optional(),
      generated_at: boundedString,
      models: z.record(z.string().max(1024), threatModelEntrySchema),
    })
    .strip(),
])

/**
 * One side of a redacted proxy exchange. The engine redacts secret-bearing
 * headers and bounds body samples before writing; the reader still bounds
 * every field so a malformed artifact cannot smuggle unbounded content into
 * durable evidence storage.
 */
const httpExchangeHeaderMapSchema = z.record(
  z.string().max(256),
  z.string().max(MAX_HTTP_EXCHANGE_BODY_CHARS)
)

const httpExchangeRequestSchema = z
  .object({
    method: z.string().max(16).optional(),
    host: z.string().max(512).optional(),
    port: z.number().int().min(0).max(65535).nullable().optional(),
    path: z.string().max(2048).optional(),
    target: z.string().max(2048).optional(),
    is_tls: z.boolean().optional(),
    created_at: boundedString,
    headers: httpExchangeHeaderMapSchema.optional(),
    body_sample: z.string().max(MAX_HTTP_EXCHANGE_BODY_CHARS).optional(),
    body_truncated: z.boolean().optional(),
    body_bytes: z.number().int().min(0).optional(),
    sha256: z.string().max(128).nullable().optional(),
  })
  .strip()

const httpExchangeResponseSchema = z
  .object({
    status_code: z.number().int().min(100).max(599).nullable().optional(),
    length: z.number().int().min(0).nullable().optional(),
    roundtrip_ms: z.number().min(0).nullable().optional(),
    created_at: boundedString,
    headers: httpExchangeHeaderMapSchema.optional(),
    body_sample: z.string().max(MAX_HTTP_EXCHANGE_BODY_CHARS).optional(),
    body_truncated: z.boolean().optional(),
    body_bytes: z.number().int().min(0).optional(),
    sha256: z.string().max(128).nullable().optional(),
  })
  .strip()

const httpExchangeEntrySchema = z
  .object({
    proxy_request_id: httpExchangeIdSchema,
    request: httpExchangeRequestSchema.optional(),
    response: httpExchangeResponseSchema.optional(),
  })
  .strip()

/**
 * http_exchanges.json — the bounded redacted proxy-exchange export the engine
 * writes before sandbox teardown (upstream HTTP_EXCHANGES_SCHEMA =
 * "lyrashield-http-exchanges/1.0"). `exchanges[].proxy_request_id` values are
 * the only ids a finding may cite in `http_exchange_ids`; `binding` ties the
 * export to the run, and `missing_request_ids`/`truncated` record export gaps.
 */
export const httpExchangeExportSchema = z
  .object({
    schema_version: z.union([z.number().int().min(0), z.string().max(64)]).optional(),
    generated_at: boundedString,
    binding: z
      .object({
        run_id: boundedString,
        run_name: nullableBoundedString,
        targets: z.array(z.unknown()).max(64).optional(),
        report_artifacts_revision: z.number().int().min(0).nullable().optional(),
        findings: z
          .record(z.string().max(256), z.array(httpExchangeIdSchema).max(MAX_HTTP_EXCHANGE_IDS))
          .optional(),
      })
      .strip()
      .optional(),
    exchanges: z.array(httpExchangeEntrySchema).max(MAX_HTTP_EXCHANGE_ENTRIES),
    missing_request_ids: z.array(httpExchangeIdSchema).max(MAX_HTTP_EXCHANGE_ENTRIES).optional(),
    truncated: z
      .object({
        exchange_limit: z.number().int().min(0).optional(),
        omitted_request_ids: z
          .array(httpExchangeIdSchema)
          .max(MAX_HTTP_EXCHANGE_ENTRIES)
          .optional(),
      })
      .strip()
      .optional(),
  })
  .strip()

const targetInfoSchema = z
  .object({
    details: z
      .object({
        cloned_repo_path: boundedString,
      })
      .strip()
      .optional(),
  })
  .strip()

const usageEntrySchema = z
  .object({
    model: boundedString,
    input_tokens: z.number().int().min(0).optional(),
    output_tokens: z.number().int().min(0).optional(),
    cached_input_tokens: z.number().int().min(0).optional(),
    cache_write_input_tokens: z.number().int().min(0).optional(),
    input_tokens_details: z
      .object({
        cached_tokens: z.number().int().min(0).optional(),
        cache_write_tokens: z.number().int().min(0).optional(),
      })
      .strip()
      .optional(),
  })
  .strip()

const sha256Hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "Expected SHA-256 hex")
  .optional()

export const engineRunRecordSchema = z
  .object({
    // Producer's run.json contract version (engine RUN_RECORD_SCHEMA_VERSION).
    // Optional because runs produced before the field existed are still valid.
    // The object is `.strip()`ed, so declaring it here makes it readable rather
    // than silently dropped.
    schema_version: boundedString,
    run_id: nonEmptyString,
    run_name: nullableBoundedString,
    start_time: boundedString,
    end_time: nullableBoundedString,
    status: nonEmptyString,
    phase: boundedString,
    seq: z.number().int().min(0).optional(),
    turn_count: z.number().int().min(0).optional(),
    targets_info: z.array(targetInfoSchema).max(10).optional(),
    llm_usage: z
      .union([z.array(usageEntrySchema).max(1000), z.record(z.string(), z.unknown())])
      .optional(),
    engine_version: boundedString,
    prompt_bundle_hash: sha256Hash,
    model: boundedString,
    reasoning_effort: boundedString,
    delegate_model: boundedString,
    delegate_reasoning_effort: boundedString,
    model_routing_policy: boundedString,
    compaction_trigger_tokens: z.number().int().min(1).optional(),
    compaction_target_tokens: z.number().int().min(1).optional(),
    max_output_tokens: z.number().int().min(1).optional(),
    max_agents: z.number().int().min(1).optional(),
    cleanup: z
      .object({
        sandbox_removed: z.boolean(),
      })
      .strip()
      .optional(),
    scan_mode: boundedString,
    terminal_reason: z
      .enum([
        "completed",
        "content_filter_stopped",
        "engine_stopped",
        "budget_exceeded",
        "incomplete",
        "rate_limited",
        "cancelled",
        "timed_out",
      ])
      .optional(),
    // ── run.json 1.1 run-level evidence stamps ─────────────────────────────
    /** Monotonic revision of the run's report artifacts (append-only writes). */
    report_artifacts_revision: z.number().int().min(0).optional(),
    /**
     * The engine's recorded HTTP-exchange export outcome — evidence-status
     * metadata only (exported/partial/skipped/failed), never a verification
     * receipt. The exported file remains the authoritative ref index.
     */
    evidence_export: z
      .object({
        status: z.enum(["exported", "partial", "skipped", "failed"]).optional(),
        reason: boundedString,
        exchanges: z.number().int().min(0).optional(),
        missing_request_ids: z
          .array(httpExchangeIdSchema)
          .max(MAX_HTTP_EXCHANGE_ENTRIES)
          .optional(),
      })
      .strip()
      .optional(),
  })
  .strip()

/**
 * The run.json major version this worker's schema is written against. The
 * engine emits RUN_RECORD_SCHEMA_VERSION ("1.0" for schema 1.0, "1.1" once the
 * evidence fields are enabled); MAJOR bumps mean the cross-repo contract moved
 * (field removed/renamed/re-meaned), MINOR bumps are additive.
 */
const EXPECTED_RUN_RECORD_SCHEMA_MAJOR = 1

interface RunRecordSchemaVersionCheck {
  level: "warn" | "error"
  message: string
}

/**
 * Tripwire for cross-repo run.json contract drift. Because the worker schema
 * is `.strip()`ed, an unknown or removed field does not error on its own; this
 * check makes a MAJOR version move observable instead of silently misread.
 * MINOR (additive) bumps stay silent per the bump policy. An "error" result
 * is a rejection signal: callers must refuse to ingest the record rather than
 * guess at a contract they do not understand.
 */
export function checkRunRecordSchemaVersion(
  schemaVersion: string | undefined
): RunRecordSchemaVersionCheck | null {
  if (schemaVersion === undefined || schemaVersion.trim() === "") {
    return {
      level: "warn",
      message: "run.json predates schema versioning; engine contract version unknown",
    }
  }
  const parts = schemaVersion.trim().split(".")
  const major = Number(parts[0])
  const minorRaw = parts[1]
  const parsable =
    parts.length <= 2 &&
    parts[0] !== "" &&
    Number.isInteger(major) &&
    major >= 0 &&
    (minorRaw === undefined || (minorRaw !== "" && Number.isInteger(Number(minorRaw))))
  if (!parsable) {
    return {
      level: "warn",
      message: `run.json schema_version is not a parsable major[.minor] value: ${schemaVersion}`,
    }
  }
  if (major !== EXPECTED_RUN_RECORD_SCHEMA_MAJOR) {
    return {
      level: "error",
      message:
        `run.json schema major version moved: engine sent ${major}.x, worker understands ` +
        `${EXPECTED_RUN_RECORD_SCHEMA_MAJOR}.x — the run-record contract changed and the ` +
        `worker schema must be updated deliberately`,
    }
  }
  return null
}
