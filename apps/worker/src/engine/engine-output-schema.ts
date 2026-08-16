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
    dependency_metadata: z.record(z.string(), z.string().max(64 * 1024)).optional(),
    poc_description: boundedString,
    poc_script_code: boundedString,
    remediation_steps: boundedString,
    control_ids: z.array(z.number().int().min(1).max(50)).max(50).optional(),
    code_locations: z.array(codeLocationSchema).max(100).optional(),
    agent_id: boundedString,
    agent_name: boundedString,
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
  })
  .strip()

export type EngineVulnerabilitySchema = z.infer<typeof engineVulnerabilitySchema>
export type EngineRunRecordSchema = z.infer<typeof engineRunRecordSchema>

/**
 * The run.json major version this worker's schema is written against. The
 * engine emits RUN_RECORD_SCHEMA_VERSION (currently "1.0"); MAJOR bumps mean
 * the cross-repo contract moved (field removed/renamed/re-meaned), MINOR bumps
 * are additive.
 */
export const EXPECTED_RUN_RECORD_SCHEMA_MAJOR = 1

export interface RunRecordSchemaVersionCheck {
  level: "warn" | "error"
  message: string
}

/**
 * Tripwire for cross-repo run.json contract drift — never a gate. Because the
 * worker schema is `.strip()`ed, an unknown or removed field does not error on
 * its own; this check makes a MAJOR version move observable instead of
 * silently misread. MINOR (additive) bumps stay silent per the bump policy.
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
