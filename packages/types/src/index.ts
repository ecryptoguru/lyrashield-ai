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
  name: z.string().min(1).max(100),
  mode: WorkspaceModeSchema.default("VIBE"),
})

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>

export const CreateProjectSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>

export const CreateRepoTargetSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  type: z.literal("REPO"),
  name: z.string().min(1).max(100),
  repoProvider: z.string().default("github"),
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  branch: z.string().optional(),
  environment: TargetEnvironmentSchema.default("STAGING"),
})

export const CreateUrlTargetSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().optional(),
  type: z.enum(["WEB_APP", "API"]),
  name: z.string().min(1).max(100),
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
  total: number
  page: number
  pageSize: number
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
