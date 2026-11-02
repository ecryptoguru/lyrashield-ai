import { createHash } from "node:crypto"
import {
  advisoryCvssSchema,
  findingRevisionSchema,
  fixVerificationSchema,
  MAX_EVIDENCE_FIELD_CHARS,
  MAX_FINDING_REVISIONS,
  MAX_HTTP_EXCHANGE_IDS,
} from "./engine-output-schema"
import { HTTP_EXCHANGE_ID_PATTERN, recordIngestionIssue } from "./output-parser-common"
import type {
  AdvisoryCvss,
  EngineVulnerability,
  EngineRunRecord,
  ParsedHttpExchangeExport,
  HttpExchangeBinding,
  FindingRevision,
  FixVerificationAttestation,
} from "./output-parser-types"

/**
 * Per-artifact evidence context for the ingestion path.
 *
 * `httpExchangeIds` carries the run's exported exchange-id index:
 * - `undefined` — the caller supplies no export context (standalone parsing);
 *   declared refs are carried as engine-asserted evidence, never trusted.
 * - `null` — an ingestion context exists but the export is absent or
 *   unreadable; declared refs are omitted and a warning is recorded.
 * - `Set<string>` — the current scan's exchange ids; refs not in the set are
 *   unknown and fail validation.
 */
export interface EvidenceIngestionContext {
  issues?: string[]
  httpExchangeIds?: Set<string> | null
  /** Undefined: legacy contract; null: 1.2 manifest/run binding failed. */
  httpExchangeBinding?: HttpExchangeBinding | null
  httpExchangeRequestHosts?: Map<string, string>
  httpExchangeExcludedIds?: Set<string>
}

/** 1.2 refs require an exact manifest and run binding before per-finding checks. */
export function bindHttpExchangeEvidence(
  run: EngineRunRecord | null,
  runJsonRaw: string,
  vulnerabilitiesRaw: string,
  httpExchangesRaw: string | null | undefined,
  exported: ParsedHttpExchangeExport | null
): HttpExchangeBinding | null | undefined {
  let record
  try {
    record = JSON.parse(runJsonRaw)
  } catch {
    return undefined
  }
  if (record?.schema_version !== "1.2") return undefined
  const binding = exported?.binding
  if (
    !run ||
    !binding ||
    exported?.schemaVersion !== "lyrashield-http-exchanges/1.0" ||
    !["exported", "partial"].includes(run.evidence_export?.status ?? "") ||
    !run.evidence_export?.exchanges ||
    run.evidence_export.exchanges !== exported.exchangeCount ||
    !run.run_id ||
    !run.run_name ||
    !Number.isInteger(run.report_artifacts_revision) ||
    binding.run_id !== run.run_id ||
    binding.run_name !== run.run_name ||
    binding.report_artifacts_revision !== run.report_artifacts_revision ||
    typeof httpExchangesRaw !== "string" ||
    record.result_manifest?.schema_version !== 1
  )
    return null
  for (const [path, raw] of [
    ["vulnerabilities.json", vulnerabilitiesRaw],
    ["http_exchanges.json", httpExchangesRaw],
  ] as const) {
    const entry = record.result_manifest?.artifacts?.[path]
    if (
      entry?.path !== path ||
      entry?.bytes !== Buffer.byteLength(raw, "utf8") ||
      entry?.sha256 !== createHash("sha256").update(raw, "utf8").digest("hex")
    )
      return null
  }
  return binding
}

export function evidenceString(
  value: unknown,
  field: string,
  findingId: string,
  issues?: string[]
): string | undefined {
  if (value === undefined) return undefined
  // The 1.1 evidence fields carry the writer's own 10K bound, not the looser
  // legacy 64K text bound.
  const result =
    typeof value === "string" && value.length <= MAX_EVIDENCE_FIELD_CHARS ? value : undefined
  if (result === undefined) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: ${field} is malformed or oversized — field dropped`
    )
  }
  return result
}

export function parseEngineConfidence(
  value: unknown,
  findingId: string,
  issues?: string[]
): EngineVulnerability["engine_confidence"] {
  if (value === undefined) return undefined
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : undefined
  if (candidate === "high" || candidate === "medium" || candidate === "low") {
    return candidate
  }
  recordIngestionIssue(
    issues,
    `finding ${findingId}: confidence claim is not a recognized level — field dropped`
  )
  return undefined
}

export function parseAdvisoryCvss(
  value: unknown,
  findingId: string,
  issues?: string[]
): AdvisoryCvss | undefined {
  if (value === undefined) return undefined
  // A bare advisory number normalizes to the structured form so nothing
  // downstream sees an unlabelled number; every other non-object shape drops.
  let candidate: unknown = value
  if (typeof value === "number") {
    candidate = value >= 0 && value <= 10 ? { score: value } : undefined
  } else if (typeof value !== "object" || value === null || Array.isArray(value)) {
    candidate = undefined
  }
  if (candidate === undefined) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: advisory_cvss is not a bounded score or structured object — field dropped`
    )
    return undefined
  }
  const parsed = advisoryCvssSchema.safeParse(candidate)
  if (!parsed.success) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: advisory_cvss failed validation — field dropped`
    )
    return undefined
  }
  return parsed.data
}

/**
 * fix_verification accepts a bare statement string or the attestation object
 * and always normalizes to `{kind: "engine_attestation", ...}` — matching the
 * upstream writer so the marker survives the worker boundary intact.
 */
export function parseFixVerification(
  value: unknown,
  findingId: string,
  issues?: string[]
): FixVerificationAttestation | undefined {
  if (value === undefined) return undefined
  const candidate = typeof value === "string" ? { statement: value } : value
  const parsed = fixVerificationSchema.safeParse(candidate)
  if (!parsed.success) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: fix_verification is malformed — field dropped`
    )
    return undefined
  }
  return { ...parsed.data, kind: parsed.data.kind ?? "engine_attestation" }
}

export function parseHttpExchangeIds(
  value: unknown,
  findingId: string,
  ctx?: EvidenceIngestionContext,
  findingRevision = 0,
  finding?: Pick<EngineVulnerability, "target" | "endpoint" | "evidence_contract_version">
): { ids?: string[]; refsDropped?: boolean } {
  if (value === undefined) return {}
  if (!Array.isArray(value)) {
    recordIngestionIssue(
      ctx?.issues,
      `finding ${findingId}: http_exchange_ids is not a list — field dropped`
    )
    return { refsDropped: true }
  }
  const distinct: string[] = []
  let malformed = false
  for (const item of value) {
    if (typeof item !== "string" || !HTTP_EXCHANGE_ID_PATTERN.test(item)) {
      malformed = true
      continue
    }
    if (!distinct.includes(item)) distinct.push(item)
  }
  if (malformed) {
    recordIngestionIssue(
      ctx?.issues,
      `finding ${findingId}: http_exchange_ids contained non-numeric or oversized ids — entries dropped`
    )
  }
  if (distinct.length === 0) return { refsDropped: value.length > 0 }
  if (distinct.length > MAX_HTTP_EXCHANGE_IDS) {
    recordIngestionIssue(
      ctx?.issues,
      `finding ${findingId}: http_exchange_ids exceeds ${MAX_HTTP_EXCHANGE_IDS} distinct ids — field dropped`
    )
    return { refsDropped: true }
  }
  if (finding?.evidence_contract_version === "1.2" && ctx?.httpExchangeBinding === undefined) {
    recordIngestionIssue(
      ctx?.issues,
      `finding ${findingId}: http_exchange_ids require a valid 1.2 run evidence context — field dropped`
    )
    return { refsDropped: true }
  }
  if (ctx?.httpExchangeBinding !== undefined) {
    const binding = ctx.httpExchangeBinding
    const findingIds = binding?.findings?.[findingId]
    let expectedHost: string | undefined
    for (const candidate of [finding?.target, finding?.endpoint]) {
      if (!candidate) continue
      try {
        const host = new URL(candidate).hostname.replace(/^\[|\]$/g, "")
        if (host) {
          expectedHost = host.toLowerCase().replace(/\.+$/, "")
          break
        }
      } catch {
        /* A relative endpoint cannot establish target ownership. */
      }
    }
    if (
      !binding ||
      !Array.isArray(findingIds) ||
      binding.finding_revisions?.[findingId] !== findingRevision ||
      !expectedHost ||
      distinct.some(
        (id) =>
          !findingIds.includes(id) ||
          ctx.httpExchangeExcludedIds?.has(id) ||
          ctx.httpExchangeRequestHosts?.get(id) !== expectedHost
      )
    ) {
      recordIngestionIssue(
        ctx.issues,
        `finding ${findingId}: http_exchange_ids lack a matching run/manifest/finding revision binding — field dropped`
      )
      return { refsDropped: true }
    }
  }
  // No exchange-export context: carry the refs as engine-asserted evidence.
  // They are claims, not verification receipts.
  if (ctx?.httpExchangeIds === undefined) return { ids: distinct }
  if (ctx.httpExchangeIds === null) {
    recordIngestionIssue(
      ctx.issues,
      `finding ${findingId}: proxy exchange export unavailable — http_exchange_ids omitted (unverifiable)`
    )
    return { refsDropped: true }
  }
  const knownIds: Set<string> = ctx.httpExchangeIds
  const unknown = distinct.filter((id) => !knownIds.has(id))
  if (unknown.length > 0) {
    recordIngestionIssue(
      ctx.issues,
      `finding ${findingId}: http_exchange_ids reference unknown exchange id(s) ${unknown
        .map((id) => id.slice(0, 32))
        .join(", ")} — field dropped`
    )
    return { refsDropped: true }
  }
  return { ids: distinct }
}

/** Pending claims are shape-checked only, independently of the exported index. */
export function parsePendingHttpExchangeIds(
  value: unknown,
  findingId: string,
  issues?: string[]
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: pending_http_exchange_ids is not a list — field dropped`
    )
    return undefined
  }
  const distinct = new Set<string>()
  let malformed = false
  for (const item of value) {
    if (typeof item !== "string" || !HTTP_EXCHANGE_ID_PATTERN.test(item)) {
      malformed = true
      continue
    }
    distinct.add(item)
    if (distinct.size > MAX_HTTP_EXCHANGE_IDS) {
      recordIngestionIssue(
        issues,
        `finding ${findingId}: pending_http_exchange_ids exceeds ${MAX_HTTP_EXCHANGE_IDS} distinct ids — field dropped`
      )
      return undefined
    }
  }
  if (malformed) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: pending_http_exchange_ids contained non-numeric or oversized ids — entries dropped`
    )
  }
  return distinct.size ? [...distinct] : undefined
}

export function parseEvidenceWarnings(
  value: unknown,
  findingId: string,
  issues?: string[]
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: evidence_warnings is not a list — field dropped`
    )
    return undefined
  }
  const warnings: string[] = []
  let dropped = 0
  for (const item of value.slice(0, 10)) {
    if (typeof item === "string" && item.length <= MAX_EVIDENCE_FIELD_CHARS) {
      warnings.push(item)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: ${dropped} malformed evidence_warnings entr${dropped === 1 ? "y" : "ies"} dropped`
    )
  }
  if (value.length > 10) {
    recordIngestionIssue(issues, `finding ${findingId}: evidence_warnings truncated at 10 entries`)
  }
  return warnings.length > 0 ? warnings : undefined
}

export function parseUpdateHistory(
  value: unknown,
  findingId: string,
  issues?: string[]
): FindingRevision[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: update_history is not a list — field dropped`
    )
    return undefined
  }
  const entries: FindingRevision[] = []
  let dropped = 0
  for (const item of value.slice(0, MAX_FINDING_REVISIONS)) {
    const parsed = findingRevisionSchema.safeParse(item)
    if (parsed.success) {
      entries.push(parsed.data)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: ${dropped} malformed update_history entr${dropped === 1 ? "y" : "ies"} dropped`
    )
  }
  if (value.length > MAX_FINDING_REVISIONS) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: update_history truncated at ${MAX_FINDING_REVISIONS} revisions`
    )
  }
  return entries.length > 0 ? entries : undefined
}
