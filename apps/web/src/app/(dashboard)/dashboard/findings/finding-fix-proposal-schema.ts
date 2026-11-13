import { z } from "zod"

export const fixProposalSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    summary: z.string(),
    hasStoredPatch: z.boolean().optional(),
    createdAt: z.string().optional(),
    pullRequests: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            prNumber: z.number().nullable(),
            prUrl: z.string().nullable(),
            branchName: z.string(),
            createdAt: z.string(),
            mergedAt: z.string().nullable(),
            closedAt: z.string().nullable(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough()
