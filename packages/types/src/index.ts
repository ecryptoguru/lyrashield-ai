import { z } from "zod"

export const WorkspaceModeSchema = z.enum(["VIBE", "TEAM", "ENTERPRISE"])
export const WorkspacePlanSchema = z.enum(["FREE", "PRO", "TEAM", "AGENCY", "BUSINESS", "ENTERPRISE"])
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
export const TargetTypeSchema = z.enum(["REPO", "WEB_APP", "API", "CLOUD_ACCOUNT", "CONTAINER", "IAC"])
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
export const ScanStatusSchema = z.enum([
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REQUIRES_APPROVAL",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])
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
export type IntegrationType = z.infer<typeof IntegrationTypeSchema>

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).trim().refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
  mode: WorkspaceModeSchema.default("VIBE"),
})

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>

export const CreateProjectSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(100).trim().refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
  description: z.string().max(500).optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>

export const CreateRepoTargetSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  type: z.literal("REPO"),
  name: z.string().min(1).max(100).trim().refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
  repoProvider: z.string().default("github"),
  repoOwner: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "Invalid repo owner"),
  repoName: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "Invalid repo name"),
  branch: z.string().max(255).optional(),
  environment: TargetEnvironmentSchema.default("STAGING"),
})

export const CreateUrlTargetSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  type: z.enum(["WEB_APP", "API"]),
  name: z.string().min(1).max(100).trim().refine((v) => !/[\u0000-\u001F\u007F]/.test(v), "Control characters not allowed"),
  url: z.url(),
  environment: TargetEnvironmentSchema.default("STAGING"),
})

export const CreateScanSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  goal: ScanGoalSchema,
  mode: ScanModeSchema.default("SAFE"),
  policyId: z.string().optional(),
})

export type CreateScanInput = z.infer<typeof CreateScanSchema>

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
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

export const UpdateOnboardingSchema = z.object({
  currentStep: z.number().int().min(0).max(6).optional(),
  completed: z.boolean().optional(),
  skipped: z.boolean().optional(),
  workspaceId: z.string().optional().nullable(),
  targetId: z.string().optional().nullable(),
  selectedGoal: ScanGoalSchema.optional().nullable(),
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

export type DeterminismMode = "default" | "strict" | "best-effort"

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

export interface ScanJobData {
  scanId: string
  workspaceId: string
  targetId: string
  goal: string
  mode: string
  policyId?: string
}

export type ScanJobResult = {
  status: "completed" | "failed"
  summary?: string
  errorCategory?: string
  errorMessage?: string
}
