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
    run_id: nonEmptyString,
    run_name: nullableBoundedString,
    start_time: boundedString,
    end_time: nullableBoundedString,
    status: nonEmptyString,
    targets_info: z.array(targetInfoSchema).max(10).optional(),
    llm_usage: z
      .union([z.array(usageEntrySchema).max(1000), z.record(z.string(), z.unknown())])
      .optional(),
    engine_version: boundedString,
    prompt_bundle_hash: sha256Hash,
    model: boundedString,
    reasoning_effort: boundedString,
    max_output_tokens: z.number().int().min(1).optional(),
    max_agents: z.number().int().min(1).optional(),
    scan_mode: boundedString,
    terminal_reason: boundedString,
  })
  .strip()

export type EngineVulnerabilitySchema = z.infer<typeof engineVulnerabilitySchema>
export type EngineRunRecordSchema = z.infer<typeof engineRunRecordSchema>
