import { z } from "zod"

/** Lenient date validator: accepts ISO 8601 or any string. */
export const dateString = z.string().datetime().or(z.string())

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
    currentStep: z.number(),
    completed: z.boolean(),
    skipped: z.boolean(),
    workspaceId: z.string().nullable(),
    targetId: z.string().nullable(),
    selectedGoal: z.string().nullable(),
  })
  .passthrough()

export const githubRepoSchema = z
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

export const targetSchema = z
  .object({
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

export const createAiAssuranceEvidenceSchema = z.object({
  workspaceId: z.string(),
  targetId: z.string(),
  controlId: z.string(),
  attestation: z.string().min(1).max(5000),
  expiresAt: z.string().datetime().nullable().default(null),
})

export const reviseAiAssuranceEvidenceSchema = z.object({
  workspaceId: z.string(),
  attestation: z.string().min(1).max(5000),
  expiresAt: z.string().datetime().nullable().default(null),
})

export const reviewAiAssuranceEvidenceSchema = z.object({
  workspaceId: z.string(),
  status: z.enum(["ACCEPTED", "REJECTED"]),
})
