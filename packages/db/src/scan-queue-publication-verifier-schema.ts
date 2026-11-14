import { z } from "zod"
import { ScanJobDataSchema } from "@lyrashield/types"
import { queueOutboxScopeSchema } from "./scan-queue-outbox-store"

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
export const queuePublicationVerificationInputSchema = z
  .object({
    ...queueOutboxScopeSchema.shape,
    operationId: identity,
    workspaceId: identity,
    snapshot: z
      .object({
        id: identity,
        queueName: z.literal("scans"),
        name: z.literal("scan"),
        data: ScanJobDataSchema.strict(),
        state: z.enum([
          "waiting",
          "delayed",
          "paused",
          "prioritized",
          "active",
          "completed",
          "failed",
          "waiting-children",
        ]),
      })
      .strict(),
  })
  .strict()

export const queuePublicationVerificationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("closed") }).strict(),
  z
    .object({
      kind: z.literal("published"),
      row: z
        .object({
          operationId: identity,
          id: identity,
          workspaceId: identity,
          executionPlanHash: checksum,
          requestDigest: checksum,
          payloadInputJson: z.string().min(1).max(4096),
        })
        .strict(),
    })
    .strict(),
])
export type QueuePublicationVerificationResult = z.infer<
  typeof queuePublicationVerificationResultSchema
>
