import { logger } from "@lyrashield/logger"
import type { z } from "zod"
import {
  coverageGapSchema,
  engineCoverageDocumentSchema,
  httpExchangeExportSchema,
  MAX_COVERAGE_GAPS,
  MAX_SCOPED_COVERAGE_ENTRIES,
  MAX_THREAT_MODELS,
  scopedCoverageEntrySchema,
  threatModelEntrySchema,
  threatModelsDocumentSchema,
} from "./engine-output-schema"
import { recordIngestionIssue } from "./output-parser-common"
import type {
  EngineCoverageGap,
  ParsedEngineCoverage,
  ParsedHttpExchangeExport,
  ParsedThreatModelEntry,
  ParsedThreatModels,
  ScopedCoverageEntry,
} from "./output-parser-types"

function parseJsonArtifact(raw: string, artifact: string, issues?: string[]): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    recordIngestionIssue(issues, `${artifact}: invalid JSON — artifact ignored`)
    return undefined
  }
}

/**
 * coverage.json — the engine's scoped coverage ledger. Entries and gaps are
 * model/runtime declarations; they map into namespaced coverage receipts and
 * never alter deterministic control outcomes.
 */
export function parseEngineCoverage(
  raw: string | null | undefined,
  issues?: string[]
): ParsedEngineCoverage | null {
  if (raw === undefined) return null
  if (raw === null) {
    recordIngestionIssue(issues, "coverage.json unreadable or oversized — artifact ignored")
    return null
  }
  if (!raw.trim()) return null
  const data = parseJsonArtifact(raw, "coverage.json", issues)
  if (data === undefined) return null
  const parsed = engineCoverageDocumentSchema.safeParse(data)
  if (!parsed.success) {
    recordIngestionIssue(issues, "coverage.json failed schema validation — artifact ignored")
    logger.warn("Engine output: coverage.json failed schema validation", {
      errors: parsed.error.issues.map((issue) => issue.message).slice(0, 20),
    })
    return null
  }
  const doc = parsed.data
  if (doc.truncated?.entries_dropped) {
    recordIngestionIssue(
      issues,
      `coverage.json: engine dropped ${doc.truncated.entries_dropped} entr${doc.truncated.entries_dropped === 1 ? "y" : "ies"} at its ${doc.truncated.entry_limit ?? "declared"} limit`
    )
  }
  const rawEntries = doc.entries ?? []
  if (rawEntries.length > MAX_SCOPED_COVERAGE_ENTRIES) {
    recordIngestionIssue(
      issues,
      `coverage.json: entries truncated at ${MAX_SCOPED_COVERAGE_ENTRIES}`
    )
  }
  const entries: ScopedCoverageEntry[] = []
  const seenIds = new Set<string>()
  let dropped = 0
  for (const [index, rawEntry] of rawEntries.slice(0, MAX_SCOPED_COVERAGE_ENTRIES).entries()) {
    const parsedEntry = scopedCoverageEntrySchema.safeParse(rawEntry)
    if (!parsedEntry.success) {
      dropped += 1
      continue
    }
    const entry = parsedEntry.data
    // The overlay contract uses `id`/`subject`/`investigation_status`/`reason`;
    // the substrate renders `entry_id`/`surface`/`outcome`/`evidence`. Accept
    // either spelling so substrate-only documents still map.
    const declaredId = (entry.id ?? entry.entry_id ?? "").trim()
    const id = declaredId || `entry-${index + 1}`
    if (seenIds.has(id)) {
      recordIngestionIssue(
        issues,
        `coverage.json: duplicate entry id ${id.slice(0, 64)} — entry dropped`
      )
      dropped += 1
      continue
    }
    seenIds.add(id)
    const surface = (entry.subject ?? entry.surface ?? "").trim()
    if (!surface) {
      dropped += 1
      continue
    }
    const outcome = entry.investigation_status ?? entry.outcome
    const reason = (entry.reason ?? entry.evidence ?? "").trim()
    entries.push({
      id,
      subject: entry.risk_area ? `${surface} — ${entry.risk_area}`.slice(0, 4096) : surface,
      outcome,
      ...(reason ? { reason: reason.slice(0, 4096) } : {}),
      ...(entry.evidence_refs?.length ? { evidenceRefs: entry.evidence_refs } : {}),
      ...(entry.recorded_by ? { recordedBy: entry.recorded_by } : {}),
      ...(entry.recorded_at ? { recordedAt: entry.recorded_at } : {}),
      ...(entry.updated_at ? { updatedAt: entry.updated_at } : {}),
      ...(entry.previous_outcomes?.length ? { previousOutcomes: entry.previous_outcomes } : {}),
    })
  }
  if (dropped > 0) {
    recordIngestionIssue(
      issues,
      `coverage.json: ${dropped} entr${dropped === 1 ? "y" : "ies"} dropped — malformed or missing surface`
    )
  }
  const rawGaps = doc.gaps ?? []
  if (rawGaps.length > MAX_COVERAGE_GAPS) {
    recordIngestionIssue(issues, `coverage.json: gaps truncated at ${MAX_COVERAGE_GAPS}`)
  }
  const gaps: EngineCoverageGap[] = []
  let droppedGaps = 0
  for (const rawGap of rawGaps.slice(0, MAX_COVERAGE_GAPS)) {
    const parsedGap = coverageGapSchema.safeParse(rawGap)
    if (!parsedGap.success) {
      droppedGaps += 1
      continue
    }
    const gap = parsedGap.data
    gaps.push({
      kind: gap.kind,
      ...(gap.surface ? { subject: gap.surface.slice(0, 4096) } : {}),
      ...(!gap.surface && gap.risk_area ? { subject: gap.risk_area.slice(0, 256) } : {}),
      ...(!gap.surface && !gap.risk_area && gap.agent_name
        ? { subject: gap.agent_name.slice(0, 256) }
        : {}),
      detail: gap.detail.slice(0, 4096),
    })
  }
  if (droppedGaps > 0) {
    recordIngestionIssue(issues, `coverage.json: ${droppedGaps} malformed gap(s) dropped`)
  }
  return {
    ...(doc.schema_version !== undefined ? { schemaVersion: String(doc.schema_version) } : {}),
    entries,
    gaps,
    ...(doc.completeness
      ? {
          completeness: {
            complete: doc.completeness.complete,
            caveats: doc.completeness.caveats ?? [],
          },
        }
      : {}),
  }
}

function redactThreatModelText(value: string): string {
  return value
    .replace(
      /\b(password|passwd|pwd|api[_-]?key|secret|token|credential|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
}

/**
 * threat_model.json — the owned engine's models array. Older target-keyed
 * documents are adapted by this reader; neither form proves paths were tested.
 */
export function parseThreatModels(
  raw: string | null | undefined,
  issues?: string[],
  runId?: string
): ParsedThreatModels | null {
  if (raw === undefined) return null
  if (raw === null) {
    recordIngestionIssue(issues, "threat_model.json unreadable or oversized — artifact ignored")
    return null
  }
  if (!raw.trim()) return null
  const data = parseJsonArtifact(raw, "threat_model.json", issues)
  if (data === undefined) return null
  const parsed = threatModelsDocumentSchema.safeParse(data)
  if (!parsed.success) {
    recordIngestionIssue(issues, "threat_model.json failed schema validation — artifact ignored")
    logger.warn("Engine output: threat_model.json failed schema validation", {
      errors: parsed.error.issues.map((issue) => issue.message).slice(0, 20),
    })
    return null
  }
  const doc = parsed.data
  // Canonical owned output is an array. Older upstream documents were bare
  // records or wrapped records; a bare record may contain a key named models.
  type ThreatModelEntry = z.infer<typeof threatModelEntrySchema>
  const maybeModels = (doc as { models?: unknown }).models
  const isCanonical = Array.isArray(maybeModels)
  if (isCanonical && Object.hasOwn(doc, "error")) {
    recordIngestionIssue(issues, "threat_model.json reports a writer error — artifact ignored")
    return null
  }
  if (isCanonical && (!runId || (doc as { run_id?: unknown }).run_id !== runId)) {
    recordIngestionIssue(issues, "threat_model.json run_id mismatch — artifact ignored")
    return null
  }
  const isWrapped =
    typeof maybeModels === "object" &&
    maybeModels !== null &&
    !Array.isArray(maybeModels) &&
    !("content" in maybeModels)
  const schemaVersion =
    (isCanonical || isWrapped) && (doc as { schema_version?: unknown }).schema_version !== undefined
      ? String((doc as { schema_version?: unknown }).schema_version)
      : undefined
  const rawModels = (isCanonical || isWrapped ? maybeModels : doc) as
    ThreatModelEntry[] | Record<string, ThreatModelEntry>
  const models: ParsedThreatModelEntry[] = []
  for (const [key, model] of Object.entries(rawModels)) {
    if (models.length >= MAX_THREAT_MODELS) {
      recordIngestionIssue(issues, `threat_model.json: models truncated at ${MAX_THREAT_MODELS}`)
      break
    }
    if (
      typeof model !== "object" ||
      model === null ||
      Array.isArray(model) ||
      typeof (model as { target?: unknown }).target !== "string" ||
      !model.target.trim() ||
      typeof (model as { content?: unknown }).content !== "string" ||
      !model.content.trim()
    ) {
      recordIngestionIssue(
        issues,
        `threat_model.json: model ${key.slice(0, 64)} malformed — dropped`
      )
      continue
    }
    models.push({
      target: redactThreatModelText(model.target),
      ...(model.written_at ? { writtenAt: redactThreatModelText(model.written_at) } : {}),
      ...(model.written_by ? { writtenBy: redactThreatModelText(model.written_by) } : {}),
      content: redactThreatModelText(model.content),
      ...(model.amendments?.length
        ? {
            amendments: model.amendments.map((amendment) => ({
              ...(amendment.at ? { at: redactThreatModelText(amendment.at) } : {}),
              ...(amendment.by ? { by: redactThreatModelText(amendment.by) } : {}),
              content: redactThreatModelText(amendment.content),
            })),
          }
        : {}),
    })
  }
  if (models.length === 0) {
    recordIngestionIssue(issues, "threat_model.json contains no usable models — artifact ignored")
    return null
  }
  // Persist the validated canonical document — not raw bytes — so nothing
  // outside the declared contract reaches encrypted storage.
  const serializedModels = models.map((model) => ({
    target: model.target,
    ...(model.writtenAt ? { written_at: model.writtenAt } : {}),
    ...(model.writtenBy ? { written_by: model.writtenBy } : {}),
    content: model.content,
    ...(model.amendments?.length
      ? {
          amendments: model.amendments.map((amendment) => ({
            ...(amendment.at ? { at: amendment.at } : {}),
            ...(amendment.by ? { by: amendment.by } : {}),
            content: amendment.content,
          })),
        }
      : {}),
  }))
  const canonical = isCanonical
    ? (doc as {
        generated_at: string
        run_id: string
        run_name?: string
        note?: string
        truncated?: boolean
        error?: string
      })
    : null
  const document = JSON.stringify({
    schema_version: schemaVersion ?? "1.0",
    ...(canonical
      ? {
          generated_at: redactThreatModelText(canonical.generated_at),
          run_id: redactThreatModelText(canonical.run_id),
          ...(canonical.run_name ? { run_name: redactThreatModelText(canonical.run_name) } : {}),
          ...(canonical.note ? { note: redactThreatModelText(canonical.note) } : {}),
          ...(canonical.truncated !== undefined ? { truncated: canonical.truncated } : {}),
          ...(canonical.error ? { error: redactThreatModelText(canonical.error) } : {}),
        }
      : {}),
    models: isCanonical
      ? serializedModels
      : Object.fromEntries(serializedModels.map((model) => [model.target, model])),
  })
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    models,
    document,
  }
}

/**
 * http_exchanges.json — the bounded redacted exchange index exported before
 * sandbox teardown. The id set is the "current proxy project" a finding's
 * http_exchange_ids must validate against; raw exchange bodies never enter
 * this artifact.
 */
export function parseHttpExchangeExport(
  raw: string | null | undefined,
  issues?: string[]
): ParsedHttpExchangeExport | null {
  if (raw === undefined) return null
  if (raw === null) {
    recordIngestionIssue(
      issues,
      "http_exchanges.json unreadable or oversized — exchange refs unverifiable"
    )
    return null
  }
  if (!raw.trim()) {
    recordIngestionIssue(issues, "http_exchanges.json is empty — exchange refs unverifiable")
    return null
  }
  const data = parseJsonArtifact(raw, "http_exchanges.json", issues)
  if (data === undefined) return null
  const parsed = httpExchangeExportSchema.safeParse(data)
  if (!parsed.success) {
    recordIngestionIssue(
      issues,
      "http_exchanges.json failed schema validation — exchange refs unverifiable"
    )
    logger.warn("Engine output: http_exchanges.json failed schema validation", {
      errors: parsed.error.issues.map((issue) => issue.message).slice(0, 20),
    })
    return null
  }
  const doc = parsed.data
  const knownIds = new Set(doc.exchanges.map((exchange) => exchange.proxy_request_id))
  // Persist the validated canonical document — not raw bytes — so nothing
  // outside the declared contract reaches encrypted storage.
  const document = JSON.stringify({
    ...(doc.schema_version !== undefined ? { schema_version: doc.schema_version } : {}),
    ...(doc.generated_at ? { generated_at: doc.generated_at } : {}),
    ...(doc.binding ? { binding: doc.binding } : {}),
    exchanges: doc.exchanges,
    ...(doc.missing_request_ids?.length ? { missing_request_ids: doc.missing_request_ids } : {}),
    ...(doc.truncated ? { truncated: doc.truncated } : {}),
  })
  return {
    ...(doc.schema_version !== undefined ? { schemaVersion: String(doc.schema_version) } : {}),
    exchangeCount: doc.exchanges.length,
    knownIds,
    document,
  }
}
