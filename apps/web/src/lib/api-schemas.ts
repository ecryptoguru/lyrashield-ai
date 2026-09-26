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

export const scanTargetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    url: z.string().nullable(),
    apiSpecUrl: z.string().nullable(),
    repoFullName: z.string().nullable(),
  })
  .passthrough()

export const scanItemSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    goal: z.string(),
    mode: z.string(),
    triggerType: z.string(),
    startedAt: dateString.nullable(),
    endedAt: dateString.nullable(),
    summary: z.string().nullable(),
    errorCategory: z.string().nullable(),
    errorMessage: z.string().nullable(),
    findingCount: z.number().optional(),
    target: scanTargetSchema.nullable(),
    createdAt: dateString,
  })
  .passthrough()

export const findingDetailItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    severity: z.string(),
    status: z.string(),
    cwe: z.string().nullable(),
    cvssScore: z.number().nullable(),
    summary: z.string().nullable(),
    verified: z.boolean(),
    verificationStatus: z.string(),
    verificationMethod: z.string().nullable(),
    verificationReason: z.string().nullable(),
    createdAt: dateString,
  })
  .passthrough()

export const scansPaginatedSchema = paginatedResponseSchema(scanItemSchema)

export const scanCancelSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    endedAt: dateString.nullable(),
  })
  .passthrough()

export const scanAttachmentItemSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    mediaType: z.string(),
    byteLength: z.number().int().nonnegative(),
    checksum: z.string(),
    createdAt: z.string().or(z.date()),
  })
  .passthrough()

export const scanAttachmentListSchema = z.object({
  items: z.array(scanAttachmentItemSchema),
})

export type ScanAttachmentItem = z.infer<typeof scanAttachmentItemSchema>

export const scanEligibilitySchema = z.object({
  allowed: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  plan: z.string(),
  isTrial: z.boolean(),
  remainingMinutes: z.number(),
  // Advisory fields — absent when the server cannot derive them cheaply.
  canonicalMode: z.string().nullable().optional(),
  canonicalProfileId: z.string().nullable().optional(),
  supportedModes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        goal: z.string(),
        mode: z.string(),
        workflow: z.string().optional(),
        available: z.boolean().optional(),
        disabledReason: z.string().nullable().optional(),
        usesAi: z.boolean().nullable().optional(),
        requiresRevisionInputs: z.boolean().optional(),
        authorizationHint: z.string().nullable().optional(),
      })
    )
    .optional(),
  // EXPECTED coverage at admission — never completed coverage.
  expectedScannerFamilies: z.array(z.string()).optional(),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
  limitations: z.array(z.string()).optional(),
})

export const findingDetailItemsPaginatedSchema = paginatedResponseSchema(findingDetailItemSchema)

export const scanPollEventSchema = z
  .object({
    id: z.string(),
    stage: z.string(),
    level: z.string(),
    message: z.string(),
    metadata: z.unknown().optional(),
    createdAt: dateString.or(z.date()),
  })
  .passthrough()

// Echoed by the API only when an incremental event window was actually applied
// to the poll (see eventsAfter); lets the client prove the cursor took effect
// before merging the tail into the full list.
export const eventsCursorAppliedSchema = z.string().optional()

export const scanPollCoverageReceiptSchema = z
  .object({
    scanner: z.string(),
    controlId: z.string(),
    status: z.string(),
    reason: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough()

export const scanPollDataSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    status: z.string(),
    goal: z.string(),
    mode: z.string(),
    triggerType: z.string(),
    startedAt: dateString.or(z.date()).nullable(),
    endedAt: dateString.or(z.date()).nullable(),
    summary: z.string().nullable(),
    errorCategory: z.string().nullable(),
    errorMessage: z.string().nullable(),
    llmRequestCount: z.number().nullable().optional(),
    llmInputTokens: z.number().nullable().optional(),
    llmCachedInputTokens: z.number().nullable().optional(),
    llmOutputTokens: z.number().nullable().optional(),
    createdAt: dateString.or(z.date()),
    events: z.array(scanPollEventSchema).optional(),
    eventsCursorApplied: eventsCursorAppliedSchema,
    resultManifest: z
      .object({
        checksum: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    coverageReceipts: z.array(scanPollCoverageReceiptSchema).optional(),
    // The scan's place in the run queue while QUEUED (1-based position + total
    // waiting), so the UI can tell the user how far from the front they are.
    queuePosition: z
      .object({ position: z.number().int(), waiting: z.number().int() })
      .nullable()
      .optional(),
  })
  .passthrough()

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
