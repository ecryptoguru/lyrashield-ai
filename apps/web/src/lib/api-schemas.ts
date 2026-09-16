import { z } from "zod"

/** Lenient date validator: accepts ISO 8601 or any string. */
const dateString = z.string().datetime().or(z.string())

/** Build a Zod schema for the standard paginated envelope. */
export function paginatedResponseSchema<T>(itemSchema: z.ZodType<T>) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().nullable(),
      total: z.number().optional(),
    })
    .passthrough()
}

export const idSchema = z.object({ id: z.string() }).passthrough()

export const installUrlSchema = z.object({ installUrl: z.string() }).passthrough()

export const onboardingDataSchema = z
  .object({
    updatedAt: z.string().optional(),
    currentStep: z.number(),
    completed: z.boolean(),
    skipped: z.boolean(),
    workspaceId: z.string().nullable(),
    targetId: z.string().nullable(),
    selectedGoal: z.string().nullable(),
    buildTool: z.string().nullable().optional(),
  })
  .passthrough()

const githubRepoSchema = z
  .object({
    id: z.number(),
    fullName: z.string(),
    name: z.string(),
    owner: z.string(),
    defaultBranch: z.string(),
    private: z.boolean(),
    htmlUrl: z.string(),
    installationId: z.string(),
  })
  .passthrough()

export const githubReposSchema = z.array(githubRepoSchema)

export const findingPrioritySchema = z
  .object({
    score: z.number(),
    band: z.enum(["urgent", "high", "normal", "low"]),
    reasons: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .passthrough()

export const findingListItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
    status: z.string(),
    verified: z.boolean(),
    verificationStatus: z.string(),
    verificationMethod: z.string().nullable().optional(),
    verificationReason: z.string().nullable().optional(),
    confidence: z.string(),
    cwe: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    businessImpact: z.string().nullable().optional(),
    exploitability: z.string().nullable().optional(),
    target: z
      .object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        environment: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    _count: z
      .object({
        evidence: z.number(),
        fixProposals: z.number(),
      })
      .passthrough()
      .optional(),
    priority: findingPrioritySchema.optional(),
    firstSeenAt: dateString,
    lastSeenAt: dateString,
  })
  .passthrough()

export const findingsPaginatedSchema = paginatedResponseSchema(findingListItemSchema)

export const targetSchema = z
  .object({
    domainVerificationStatus: z.string().optional(),
    id: z.string(),
    name: z.string(),
    type: z.string(),
    url: z.string().nullable(),
    apiSpecUrl: z.string().nullable(),
    repoFullName: z.string().nullable(),
    branch: z.string().nullable(),
    environment: z.string(),
    status: z.string(),
    lastScanAt: dateString.nullable(),
    project: z
      .object({
        id: z.string(),
        name: z.string(),
      })
      .passthrough()
      .nullable(),
    scanCount: z.number(),
    findingCount: z.number(),
    createdAt: dateString,
  })
  .passthrough()

/**
 * GET /api/launch-readiness report body. Shared by the dashboard client (which
 * extends it with the optional `releaseCheck`) and the WebMCP tool, whose
 * output stays bounded to exactly this shape.
 */
export const launchReadinessReportSchema = z
  .object({
    state: z.enum(["READY", "NOT_READY", "INSUFFICIENT_EVIDENCE"]),
    verdict: z.enum(["NOT_EVALUATED", "INCONCLUSIVE", "GO", "GO_WITH_CONDITIONS", "NO_GO"]),
    score: z.number().nullable(),
    triageScore: z.number().nullable(),
    summary: z.string(),
    blockingFindings: z.number(),
    totalFindings: z.number(),
    verifiedFindings: z.number(),
    bySeverity: z.record(z.string(), z.number()),
    conditions: z.array(z.string()),
    recommendations: z.array(z.string()),
  })
  .passthrough()
