import { z } from "zod"

/**
 * Minimal runtime response schemas for the LyraShield SDK.
 *
 * These intentionally use `.passthrough()` so they validate the presence and
 * shape of the fields the SDK actually uses while allowing the API to return
 * additional fields without breaking clients.
 */

const DateString = z.string().datetime().or(z.string())

export const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  })
  .passthrough()

export const TargetSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().optional(),
    name: z.string(),
    type: z.string(),
    url: z.string().nullable().optional(),
    repoFullName: z.string().nullable().optional(),
    repoOwner: z.string().nullable().optional(),
    repoName: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    environment: z.string().optional(),
    status: z.string().optional(),
    lastScanAt: DateString.nullable().optional(),
    createdAt: DateString.optional(),
    updatedAt: DateString.optional(),
  })
  .passthrough()

export const ScanSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().optional(),
    targetId: z.string().optional(),
    goal: z.string(),
    mode: z.string(),
    status: z.string(),
    createdAt: DateString,
    updatedAt: DateString.optional(),
  })
  .passthrough()

export const ScanListSchema = z.object({
  items: z.array(ScanSchema),
  nextCursor: z.string().nullable(),
})

export const FindingSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    scanId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    severity: z.string(),
    status: z.string(),
    controlId: z.string().optional(),
    createdAt: DateString,
    updatedAt: DateString.optional(),
  })
  .passthrough()

export const FindingListSchema = z.object({
  items: z.array(FindingSchema),
  nextCursor: z.string().nullable(),
})

export const IdSchema = z.object({ id: z.string() }).passthrough()

export const WorkspaceListSchema = z.array(WorkspaceSchema)

export const TargetListSchema = z.object({
  items: z.array(TargetSchema),
  nextCursor: z.string().nullable(),
})

export const IdListSchema = z.object({
  items: z.array(IdSchema),
  nextCursor: z.string().nullable(),
})

export const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    workspaceId: z.string().optional(),
    riskScore: z.number().optional(),
    createdAt: DateString.optional(),
    updatedAt: DateString.optional(),
  })
  .passthrough()

export const ProjectListSchema = z.object({
  items: z.array(ProjectSchema),
  nextCursor: z.string().nullable(),
})

export const ReportSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string().optional(),
    type: z.string().optional(),
    workspaceId: z.string().optional(),
    scanId: z.string().nullable().optional(),
    createdAt: DateString.optional(),
    updatedAt: DateString.optional(),
  })
  .passthrough()

export const ReportListSchema = z.object({
  items: z.array(ReportSchema),
  nextCursor: z.string().nullable(),
})

export const ScheduleSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().optional(),
    targetId: z.string().optional(),
    cron: z.string().optional(),
    goal: z.string().optional(),
    mode: z.string().optional(),
    enabled: z.boolean().optional(),
    lastRunAt: DateString.nullable().optional(),
    nextRunAt: DateString.nullable().optional(),
    createdAt: DateString.optional(),
    updatedAt: DateString.optional(),
  })
  .passthrough()

export const ScheduleListSchema = z.object({
  items: z.array(ScheduleSchema),
  nextCursor: z.string().nullable(),
})

export const AgentApprovalSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().optional(),
    actionName: z.string().optional(),
    status: z.string().optional(),
    input: z.unknown().optional(),
    requestedById: z.string().optional(),
    approvedById: z.string().nullable().optional(),
    approvedAt: DateString.nullable().optional(),
    deniedAt: DateString.nullable().optional(),
    executedAt: DateString.nullable().optional(),
    expiresAt: DateString.nullable().optional(),
    createdAt: DateString.optional(),
    updatedAt: DateString.optional(),
  })
  .passthrough()

export const AgentApprovalListSchema = z.object({
  items: z.array(AgentApprovalSchema),
  nextCursor: z.string().nullable(),
})

export const RetestCreatedSchema = z
  .object({
    retest: IdSchema,
    scan: IdSchema,
  })
  .passthrough()

export const LaunchReadinessSchema = z
  .object({
    verdict: z.string(),
  })
  .passthrough()
