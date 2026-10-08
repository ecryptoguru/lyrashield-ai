import { z } from "zod"
import { ScanWorkflowSchema } from "./scan-execution-plan"

export * from "./ai-safety-tests"
export * from "./agent-operations"
export * from "./json"

/**
 * Maximum simultaneously-active scans per workspace. Enforced by the scan-create
 * API route AND the scheduled-scan runner so schedules cannot bypass the cap.
 */
export const MAX_CONCURRENT_WORKSPACE_SCANS = 3

/** Both-sided scorecard referral reward, denominated in agent minutes. */
export const SCORECARD_REFERRAL_BONUS_MINUTES = 30

/**
 * The single source of truth for the stored result-manifest schema version.
 * The producer (`apps/worker` result-integrity manifest writer) stamps this on
 * every persisted manifest and the consumers (`@lyrashield/db` gate-assessment
 * snapshot parsing) accept exactly this version — anything else is an
 * unsupported manifest and fails closed. Bump deliberately; both sides move
 * together.
 */
export const RESULT_MANIFEST_VERSION = 7

export const WorkspaceModeSchema = z.enum(["VIBE", "TEAM", "ENTERPRISE"])
export const WorkspacePlanSchema = z.enum([
  "FREE",
  "STARTER",
  "PRO",
  "TEAM",
  "LAUNCH_ASSURANCE",
  "AGENCY",
  "BUSINESS",
  "ENTERPRISE",
])
export const MemberRoleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
  "SECURITY_ADMIN",
  "APPSEC_MANAGER",
  "DEVELOPER",
  "AUDITOR",
  "BILLING_ADMIN",
  "EXTERNAL_PENTESTER",
])
export const TargetTypeSchema = z.enum([
  "REPO",
  "WEB_APP",
  "API",
  "CLOUD_ACCOUNT",
  "CONTAINER",
  "IAC",
])
export const TargetEnvironmentSchema = z.enum(["LOCAL", "PREVIEW", "STAGING", "PRODUCTION"])
export const ScanGoalSchema = z.enum([
  "CHECK_PR",
  "TEST_APP",
  "LAUNCH_REVIEW",
  "WEEKLY_MONITOR",
  "FULL_PENTEST",
  "COMPLIANCE_REVIEW",
])
export const ScanModeSchema = z.enum(["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"])
export const ScanIdSchema = z.string().trim().min(1).max(128)
export const ScanStatusSchema = z.enum([
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "REQUIRES_APPROVAL",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])
export const AGENT_MINUTES_EXHAUSTED_ERROR_CATEGORY = "AGENT_MINUTES_EXHAUSTED"
export const AGENT_MINUTES_EXHAUSTED_ERROR_MESSAGE =
  "Agent-minute balance exhausted and grace period exceeded"
export const AGENT_MINUTES_OVERAGE_LIMIT_ERROR_MESSAGE = "Agent-minute overage spend limit reached"

export function isAgentMinutesExhaustedError(
  errorCategory?: string | null,
  errorMessage?: string | null
): boolean {
  return (
    errorCategory === AGENT_MINUTES_EXHAUSTED_ERROR_CATEGORY ||
    errorMessage === AGENT_MINUTES_EXHAUSTED_ERROR_MESSAGE ||
    errorMessage === AGENT_MINUTES_OVERAGE_LIMIT_ERROR_MESSAGE
  )
}
export const FindingSeveritySchema = z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"])
export const FindingStatusSchema = z.enum([
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "TICKET_CREATED",
  "FIXED_PENDING_RETEST",
  "FIXED",
  "ACCEPTED_RISK",
  "FALSE_POSITIVE",
  "DUPLICATE",
])
/**
 * Verification trust tiers — deliberately distinct states that clients must
 * never conflate: DETECTED is a recorded observation only, VALIDATED is a
 * deterministic check, VERIFIED requires independent confirmation. BLOCKED
 * and INCONCLUSIVE are explicitly non-conclusive outcomes, not failures to
 * hide. Mirrors the Prisma FindingVerificationStatus enum; kept in sync by
 * the scan-workflows parity fixture test.
 */
export const FindingVerificationStatusSchema = z.enum([
  "DETECTED",
  "VALIDATED",
  "VERIFIED",
  "BLOCKED",
  "INCONCLUSIVE",
])
export const IntegrationTypeSchema = z.enum([
  "GITHUB",
  "GITLAB",
  "AZURE_DEVOPS",
  "SLACK",
  "DISCORD",
  "JIRA",
  "LINEAR",
  "TEAMS",
  "SERVICENOW",
  "SPLUNK",
  "DATADOG",
  "SENTINEL",
  "VANTA",
  "DRATA",
])

export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>
export type WorkspacePlan = z.infer<typeof WorkspacePlanSchema>
export type MemberRole = z.infer<typeof MemberRoleSchema>
export type TargetType = z.infer<typeof TargetTypeSchema>
export type TargetEnvironment = z.infer<typeof TargetEnvironmentSchema>
export type ScanGoal = z.infer<typeof ScanGoalSchema>
export type ScanMode = z.infer<typeof ScanModeSchema>
export type ScanStatus = z.infer<typeof ScanStatusSchema>
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>
export type FindingStatus = z.infer<typeof FindingStatusSchema>
export type FindingVerificationStatus = z.infer<typeof FindingVerificationStatusSchema>
export type IntegrationType = z.infer<typeof IntegrationTypeSchema>

export const CreateWorkspaceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .trim()
    .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
  mode: WorkspaceModeSchema.default("VIBE"),
})

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>

export const CreateProjectSchema = z.object({
  workspaceId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(100)
    .trim()
    .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
  description: z.string().max(500).optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>

function isValidGitRef(value: string): boolean {
  if (
    value === "@" ||
    // Leading "-" is an option-looking token to any downstream argv consumer
    // (and an invalid ref to git itself); the deterministic retest already
    // rejects it — keep the validators consistent. (VERIFY-D-002)
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    /\s/u.test(value) ||
    /[\u0000-\u001F\u007F]/u.test(value) ||
    /[~^:?*\[\]\\]/u.test(value)
  ) {
    return false
  }
  return value
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock") && !part.endsWith(".")
    )
}

export const CreateRepoTargetSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  type: z.literal("REPO"),
  name: z
    .string()
    .min(1)
    .max(100)
    .trim()
    .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
  repoProvider: z.string().default("github"),
  repoOwner: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/, "Invalid repo owner"),
  repoName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/, "Invalid repo name"),
  // GitHub App installation ids are numeric. Constrain the shape here so an
  // arbitrary string can never reach Target.installationId; the route
  // additionally verifies the id belongs to this workspace.
  installationId: z.string().regex(/^\d+$/, "Invalid installation id").max(20).optional(),
  branch: z.string().min(1).max(255).refine(isValidGitRef, "Invalid Git branch or tag").optional(),
  environment: TargetEnvironmentSchema.default("STAGING"),
})

function urlWithoutCredsQueryOrFragment(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:") return false
    if (parsed.username || parsed.password) return false
    if (parsed.search) return false
    if (parsed.hash) return false
    return true
  } catch {
    return false
  }
}

export const CreateUrlTargetSchema = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().optional(),
    type: z.enum(["WEB_APP", "API"]),
    name: z
      .string()
      .min(1)
      .max(100)
      .trim()
      .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
    url: z.url(),
    apiSpecUrl: z
      .string()
      .refine(
        (v) => urlWithoutCredsQueryOrFragment(v),
        "OpenAPI URL must be a public HTTPS URL with no credentials, query, or fragment"
      )
      .optional(),
    environment: TargetEnvironmentSchema.default("STAGING"),
    ownershipAttested: z
      .boolean()
      .refine(
        (v) => v === true,
        "You must attest that you own or are authorized to scan this target"
      ),
  })
  .superRefine((data, ctx) => {
    if (data.apiSpecUrl && data.type !== "API") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiSpecUrl"],
        message: "OpenAPI URL is only allowed for API targets",
      })
    }
  })

export const PatchApiSpecSchema = z.object({
  workspaceId: z.string().min(1),
  apiSpecUrl: z
    .string()
    .refine(
      (v) => urlWithoutCredsQueryOrFragment(v),
      "OpenAPI URL must be a public HTTPS URL with no credentials, query, or fragment"
    )
    .nullable(),
})

export const PatchRepoRefSchema = z.object({
  workspaceId: z.string().min(1),
  branch: z.string().min(1).max(255).refine(isValidGitRef, "Invalid Git branch or tag"),
})

export const PatchTargetSchema = z.union([PatchApiSpecSchema.strict(), PatchRepoRefSchema.strict()])

// Optional emphasis areas — steer engine attention without reducing coverage.
// Emphasis is recorded on the scan and never restricts what detectors run.
export const ScanFocusSchema = z.enum([
  "auth",
  "payments",
  "llm_surface",
  "file_handling",
  "data_exposure",
])
export type ScanFocus = z.infer<typeof ScanFocusSchema>

export const CreateScanSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  goal: ScanGoalSchema,
  mode: ScanModeSchema.default("SAFE"),
  policyId: z.string().optional(),
  focus: ScanFocusSchema.optional(),
  // Optional workflow inputs. The server constructs and owns the immutable
  // execution plan — clients can never supply plans, hashes, internal
  // budgets, provider routes, or capabilities.
  workflow: ScanWorkflowSchema.optional(),
  // Review Changes comparison refs (branch names or full SHAs). The server
  // resolves them to immutable git object IDs through the authorized source
  // integration before the scan is admitted; abbreviated SHAs never persist.
  baseRef: z.string().min(1).max(255).refine(isValidGitRef, "Invalid Git ref").optional(),
  headRef: z.string().min(1).max(255).refine(isValidGitRef, "Invalid Git ref").optional(),
  // Immutable input-evidence references. IDs are recorded verbatim into the
  // server-owned execution plan (same cap as the plan contract); existence,
  // workspace scope, checksum and content-type are enforced by the artifact
  // staging boundary before anything mounts them — never by trusting this
  // list. Clients must never pass host paths.
  attachmentIds: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
  // AUTHENTICATED_ASSESSMENT only: references the recorded scoped
  // authorization artifact (a READY live-safety authorization record). The
  // server verifies it covers the exact target host before admission; it is
  // recorded verbatim into the immutable execution plan. Never a credential —
  // session material stays in the vault behind this reference.
  authorizationRef: z.string().trim().min(1).max(256).optional(),
})

/** Create-scan input with cross-field workflow rules applied. Kept as a
 * wrapper so CreateScanSchema stays a plain object for .pick()/JSON-schema
 * consumers (eligibility preflight, OpenAPI). */
export const CreateScanInputSchema = CreateScanSchema.superRefine((data, ctx) => {
  if ((data.baseRef || data.headRef) && data.workflow !== "REVIEW_CHANGES") {
    ctx.addIssue({
      code: "custom",
      path: ["workflow"],
      message: "baseRef/headRef are only valid with workflow REVIEW_CHANGES",
    })
  }
  if (data.workflow === "REVIEW_CHANGES" && !data.baseRef) {
    ctx.addIssue({
      code: "custom",
      path: ["baseRef"],
      message: "REVIEW_CHANGES requires a baseRef to compare against",
    })
  }
  if (data.authorizationRef && data.workflow !== "AUTHENTICATED_ASSESSMENT") {
    ctx.addIssue({
      code: "custom",
      path: ["authorizationRef"],
      message: "authorizationRef is only valid with workflow AUTHENTICATED_ASSESSMENT",
    })
  }
  if (data.workflow === "AUTHENTICATED_ASSESSMENT" && !data.authorizationRef) {
    ctx.addIssue({
      code: "custom",
      path: ["authorizationRef"],
      message:
        "AUTHENTICATED_ASSESSMENT requires an authorizationRef to a recorded scoped authorization",
    })
  }
})

export type CreateScanInput = z.infer<typeof CreateScanSchema>

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

export interface PaginatedResponse<T = unknown> {
  items: T[]
  nextCursor: string | null
  total?: number
}

export const OnboardingStepSchema = z.enum([
  "WORKSPACE",
  "TARGET",
  "GOAL",
  "PREFLIGHT",
  "SCAN",
  "RESULTS",
  "FIX",
])

/** Bounded enum for the "how are you building?" onboarding context selector. */
export const BuildToolSchema = z.enum([
  "codex",
  "cursor",
  "claude_code",
  "lovable",
  "copilot",
  "other",
])

export const UpdateOnboardingSchema = z.object({
  expectedUpdatedAt: z.string().datetime().optional(),
  currentStep: z.number().int().min(0).max(6).optional(),
  completed: z.boolean().optional(),
  skipped: z.boolean().optional(),
  workspaceId: z.string().optional().nullable(),
  targetId: z.string().optional().nullable(),
  selectedGoal: ScanGoalSchema.optional().nullable(),
  buildTool: BuildToolSchema.optional().nullable(),
})

export type OnboardingStep = z.infer<typeof OnboardingStepSchema>
export type UpdateOnboardingInput = z.infer<typeof UpdateOnboardingSchema>

// ── SARIF 2.1.0 types ──────────────────────────────────────────────

export interface SarifReport {
  version: "2.1.0"
  $schema: "https://json.schemastore.org/sarif-2.1.0.json"
  runs: SarifRun[]
}

export interface SarifRun {
  tool: {
    driver: {
      name: string
      version?: string
      informationUri?: string
      rules?: SarifRule[]
    }
  }
  results: SarifResult[]
}

export interface SarifRule {
  id: string
  name?: string
  shortDescription?: { text: string }
  fullDescription?: { text: string }
  helpUri?: string
  defaultConfiguration?: { level: "error" | "warning" | "note" | "none" }
  properties?: Record<string, unknown>
}

export interface SarifResult {
  ruleId: string
  level: "error" | "warning" | "note" | "none"
  message: { text: string }
  locations?: SarifLocation[]
  partialFingerprints?: Record<string, string>
  properties?: Record<string, unknown>
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string }
    region?: { startLine: number; startColumn?: number; endLine?: number; endColumn?: number }
  }
}

// ── CVSS types ─────────────────────────────────────────────────────

export interface CvssScore {
  /** CVSS v2 base score (0-10) */
  cvssScore?: number
  /** CVSS v2 vector string */
  cvssVector?: string
  /** CVSS v3.x base score (0-10) */
  cvss3Score?: number
  /** CVSS v3.x vector string */
  cvss3Vector?: string
}

// ── Scan cost & determinism ────────────────────────────────────────

export const DeterminismModeSchema = z.enum([
  "default",
  "strict",
  "best-effort",
  "targeted_scanner",
  "targeted_engine",
])
export type DeterminismMode = z.infer<typeof DeterminismModeSchema>

export interface ScanCostControls {
  estimatedCostCents?: number
  actualCostCents?: number
  determinismMode?: DeterminismMode
  sarifUri?: string
}

// ── Scan queue shared types ───────────────────────────────────────────
// Single source of truth for the BullMQ job payload exchanged between
// apps/web (producer) and apps/worker (consumer). Both import from here
// to prevent drift.

export const SCAN_QUEUE_NAME = "scans"

export const ScanJobDataSchema = z.object({
  scanId: z.string().min(1),
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  goal: ScanGoalSchema,
  mode: ScanModeSchema,
  policyId: z.string().optional(),
  focus: ScanFocusSchema.optional(),
})

export type ScanJobData = z.infer<typeof ScanJobDataSchema>

export type ScanJobResult = {
  status: "completed" | "failed"
  summary?: string
  errorCategory?: string
  errorMessage?: string
}

// ── Agent approval types ───────────────────────────────────────────

export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED"])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

// ── v1 API input schemas (source of truth for OpenAPI generation) ─────

export const ReportTypeSchema = z.enum(["developer", "executive", "compliance"])

export const CreateReportSchema = z.object({
  workspaceId: z.string().min(1),
  scanId: z.string().optional(),
  // Scopes the report to a target: the route resolves the target's latest
  // completed scan. It was accepted by POST /api/reports but absent from this
  // shared copy, so the published spec never documented it (P2-8).
  targetId: z.string().optional(),
  type: ReportTypeSchema.optional(),
  title: z.string().min(1).max(200),
})

export type CreateReportInput = z.infer<typeof CreateReportSchema>

export const ReportActionSchema = z.object({
  workspaceId: z.string().min(1),
  action: z.enum(["share", "revoke"]),
})

export type ReportActionInput = z.infer<typeof ReportActionSchema>

export const CreateFixProposalSchema = z.object({
  workspaceId: z.string().min(1),
  summary: z.string().min(10, "Summary must be at least 10 characters"),
  diffRef: z.string().optional(),
  generatedByModel: z.string().optional(),
  safetyScore: z.number().int().min(0).max(100).optional(),
})

export type CreateFixProposalInput = z.infer<typeof CreateFixProposalSchema>

export const CreateRetestSchema = z.object({
  workspaceId: z.string().min(1),
  scanId: z.string().optional(),
})

export type CreateRetestInput = z.infer<typeof CreateRetestSchema>

export const FINDING_PATCH_ACTIONS = ["false_positive", "accept_risk", "update_status"] as const

/**
 * The statuses PATCH /api/findings/:id may set. Narrower than
 * `FindingStatusSchema`: TICKET_CREATED is written by the ticket path, never by
 * this endpoint. The published spec previously promised it because the shared
 * copy listed every status while the route listed only these (P2-8).
 */
export const PATCHABLE_FINDING_STATUSES = [
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "FIXED",
  "FIXED_PENDING_RETEST",
  "ACCEPTED_RISK",
  "FALSE_POSITIVE",
  "DUPLICATE",
] as const

export const PatchFindingSchema = z
  .object({
    workspaceId: z.string().min(1),
    action: z.enum(FINDING_PATCH_ACTIONS),
    status: z.enum(PATCHABLE_FINDING_STATUSES).optional(),
    reason: z.string().max(1000).optional(),
    canonicalFindingId: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    // Not expressible in JSON Schema, so the published spec states only the
    // shape. The route still enforces it.
    if (
      (value.action === "false_positive" || value.action === "accept_risk") &&
      !value.reason?.trim()
    ) {
      context.addIssue({ code: "custom", path: ["reason"], message: "reason is required" })
    }
  })

export type PatchFindingInput = z.infer<typeof PatchFindingSchema>

export const SCHEDULE_CRON_MESSAGE = "Use a five-field schedule like '0 0 * * 0' or '30 8 * * *'"

/**
 * The cron grammar the scheduler actually accepts. `@lyrashield/db`'s
 * `getNextRunAt` requires exactly five whitespace-separated fields. Field 1 is
 * minute 0-59 and field 2 is hour 0-23. Fields 3 and 4 must be a literal `*`
 * (day-of-month and month). Field 5 is day-of-week 0-6. Any field may be `*`.
 * Otherwise it is digits with any number of leading zeros. Expressed as a
 * pattern rather than a refine because a refine is dropped silently by
 * `z.toJSONSchema`, which left the published spec saying nothing about the
 * accepted format (P2-8).
 */
export const SCHEDULE_CRON_PATTERN =
  /^\s*(?:\*|0*[0-5]?[0-9])\s+(?:\*|0*(?:[01]?[0-9]|2[0-3]))\s+\*\s+\*\s+(?:\*|0*[0-6])\s*$/

export const CreateScheduleSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  cron: z
    .string()
    .min(1, "cron expression is required")
    .regex(SCHEDULE_CRON_PATTERN, SCHEDULE_CRON_MESSAGE),
  goal: ScanGoalSchema,
  mode: z.enum(["SAFE", "QUICK", "STANDARD", "DEEP"]).default("SAFE"),
})

export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>

export const PatchScheduleSchema = z.object({
  workspaceId: z.string().min(1),
  cron: z.string().min(1).regex(SCHEDULE_CRON_PATTERN, SCHEDULE_CRON_MESSAGE).optional(),
  goal: ScanGoalSchema.optional(),
  mode: z.enum(["SAFE", "QUICK", "STANDARD", "DEEP"]).optional(),
  enabled: z.boolean().optional(),
})

export type PatchScheduleInput = z.infer<typeof PatchScheduleSchema>

export const CreatePRSchema = z.object({
  workspaceId: z.string().min(1),
})

export type CreatePRInput = z.infer<typeof CreatePRSchema>

export const FINDING_SEARCH_MAX_LENGTH = 120
export const FINDING_SEARCH_MESSAGE = `Too big: expected string to have <=${FINDING_SEARCH_MAX_LENGTH} characters`

/**
 * `q` is trimmed and then bounded. Written as a pattern on the raw input rather
 * than a transform plus `max()`, because the published spec is generated from
 * this schema: a transform is not representable in JSON Schema and a bound
 * applied after the trim would reject inputs the route accepts (P2-8). The
 * pattern is exactly `value.trim().length <= 120` — leading and trailing
 * whitespace is free, the trimmed core is bounded.
 *
 * The bound is one flat span between two whitespace runs. "The trimmed core is
 * at most 120 characters" and "whitespace, then at most 120 characters, then
 * whitespace" accept exactly the same strings, and the flat form has no
 * quantifier inside a quantifier, so `security/detect-unsafe-regex` leaves it
 * alone. The previous form nested a bounded repeat over an overlapping class
 * and was flagged.
 */
export const FINDING_SEARCH_PATTERN = /^\s*[\s\S]{0,120}\s*$/

export const FindingQuerySchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  observedInScanId: z.string().min(1).optional(),
  scanId: z.string().min(1).optional(),
  severity: FindingSeveritySchema.optional(),
  status: FindingStatusSchema.optional(),
  verified: z.enum(["true", "false"]).optional(),
  category: z.string().optional(),
  // Bounded search: trimmed, at most 120 characters, matched against title,
  // summary and CWE inside the caller's workspace only.
  q: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().regex(FINDING_SEARCH_PATTERN, FINDING_SEARCH_MESSAGE))
    .optional(),
  stats: z.enum(["true"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
})

export type FindingQueryInput = z.infer<typeof FindingQuerySchema>

export * from "./url-scan-capabilities"
export * from "./scan-profile"
export * from "./scan-execution-plan"
export * from "./retest-profile"
export * from "./plain-language"
// The attachment module shipped in 5c1aa8a3 without a barrel export — the db
// service imports it through the package root.
export * from "./scan-attachments"
export * from "./scan-quality"
