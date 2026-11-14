import { z } from "zod"
import {
  attemptBindingSchema,
  commandStatusSchema,
  executorKeySchema,
  executorPlanSchema,
  providerGrantPolicySchema,
  resourceOwnershipSchema,
  supervisorCommandSchema,
  supervisorReceiptSchema,
} from "@lyrashield/runtime-control"
import { supervisorJournalEventSchema } from "./journal-events"

const id = z.string().min(1).max(256)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const grant = z
  .object({
    providerId: id,
    grantId: id,
    grantRequestId: id.optional(),
    revoked: z.boolean(),
    unsettled: z.boolean().optional(),
  })
  .strict()
const pair = <K extends z.ZodType, V extends z.ZodType>(key: K, value: V) =>
  z.array(z.tuple([key, value]))
const attemptState = z
  .object({
    binding: attemptBindingSchema,
    plans: pair(executorKeySchema, executorPlanSchema),
    provider: providerGrantPolicySchema.optional(),
    grants: pair(id, grant),
    planned: pair(executorKeySchema, resourceOwnershipSchema),
    resources: pair(executorKeySchema, resourceOwnershipSchema),
    createAcknowledged: z.array(executorKeySchema),
    startPlanned: z.array(executorKeySchema),
    startAcknowledged: z.array(executorKeySchema),
    nativeAckGuards: z.array(id),
    nativeCreateProofs: pair(executorKeySchema, resourceOwnershipSchema),
    nativeRetirements: pair(executorKeySchema, resourceOwnershipSchema).optional(),
    nativeStartIntents: pair(
      executorKeySchema,
      supervisorJournalEventSchema.transform((event) => {
        if (event.type !== "native_invocation_planned")
          throw new Error("native start intent differs")
        return event
      })
    ),
    receipt: supervisorReceiptSchema,
    status: z.enum(["PREPARED", "RUNNING", "STOPPING", "STOPPED", "NEVER_DISPATCHED", "UNKNOWN"]),
    createdExecutors: z.array(executorKeySchema),
  })
  .strict()
const commandState = z
  .object({
    request: supervisorCommandSchema.nullable(),
    attemptId: id,
    requestHash: hash,
    status: commandStatusSchema,
    reason: z.string().max(512).optional(),
    receipt: supervisorReceiptSchema,
  })
  .strict()
export const sealedRecoverySchema = z
  .object({
    schema: z.literal("lyrashield-supervisor-recovery-snapshot/1"),
    epochId: id,
    supervisorInstanceId: id,
    sequence: z.number().int().positive().safe(),
    originalHash: hash,
    wrapperHash: hash,
    attempts: z.array(z.object({ id, state: attemptState }).strict()),
    commands: z.array(z.object({ id, state: commandState }).strict()),
  })
  .strict()
export type SealedRecoverySnapshot = z.infer<typeof sealedRecoverySchema>
