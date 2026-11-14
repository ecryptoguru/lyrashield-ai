import { z } from "zod"
import {
  attemptBindingSchema,
  commandStatusSchema,
  executorKeySchema,
  executorPlanSchema,
  providerGrantPolicySchema,
  resourceInspectionSchema,
  resourceOwnershipSchema,
  type AttemptBinding,
  type CommandStatus,
  type ExecutorKey,
  type ExecutorPlan,
  type ProviderGrantPolicy,
  type ResourceOwnership,
  type StopCommand,
  type SupervisorCommand,
  type SupervisorReceipt,
} from "@lyrashield/runtime-control"

const boundGrantSchema = z
  .object({ providerId: z.string(), grantId: z.string(), revoked: z.boolean().default(false) })
  .strict()
const storedStartCommandSchema = z
  .object({
    type: z.enum(["START_PAID", "START_UNMETERED"]),
    commandId: z.string(),
    attemptId: z.string(),
    executorKey: executorKeySchema,
    expectedReceiptHash: z.string(),
  })
  .strict()
const storedStopCommandSchema = z
  .object({
    type: z.literal("STOP"),
    commandId: z.string(),
    attemptId: z.string(),
    expectedReceiptHash: z.string(),
  })
  .strict()
const storedReconcileCommandSchema = z
  .object({
    type: z.literal("RECONCILE"),
    commandId: z.string(),
    attemptId: z.string(),
    expectedReceiptHash: z.string(),
  })
  .strict()
const storedPrepareCommandSchema = z
  .object({
    type: z.literal("PREPARE"),
    commandId: z.string(),
    attempt: attemptBindingSchema,
    executors: z.array(executorPlanSchema),
    provider: providerGrantPolicySchema.optional(),
  })
  .strict()
const storedCommandSchema = z.discriminatedUnion("type", [
  storedPrepareCommandSchema,
  storedStartCommandSchema,
  storedStopCommandSchema,
  storedReconcileCommandSchema,
])

const brokerEnvelope = {
  supervisorInstanceId: z.string().min(1).max(192),
  observedAt: z.string().datetime({ offset: true }),
}

export const supervisorJournalEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("attempt_prepared"),
      ...brokerEnvelope,
      commandId: z.string(),
      binding: attemptBindingSchema,
      executors: z.array(executorPlanSchema).min(1),
      provider: providerGrantPolicySchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("command_intent"), ...brokerEnvelope, command: storedCommandSchema })
    .strict(),
  z
    .object({
      type: z.literal("resource_create_planned"),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      executorKey: executorKeySchema,
      kind: z.enum(["container", "process"]),
      ownershipId: z.string(),
      cgroupPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["resource_create_acknowledged", "resource_start_planned"]),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      executorKey: executorKeySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("provider_grants_bound"),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      grants: z.array(boundGrantSchema).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("provider_grants_revoked"),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      grantIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource_bound"),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      ownership: z.object({}).passthrough(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource_started"),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      executorKey: executorKeySchema,
      ownership: z.object({}).passthrough(),
    })
    .strict(),
  z
    .object({
      type: z.literal("native_invocation_ack"),
      ...brokerEnvelope,
      commandId: z.string().min(3).max(192),
      attemptId: z.string().min(3).max(192),
      operationId: z.string().min(3).max(192),
      authorityEpochId: z.string().min(3).max(192),
      executorKey: executorKeySchema,
      guardId: z.string().min(3).max(192),
      nativeRequestId: z.string().min(3).max(192),
      nativeOperation: z.enum(["CONTAINER_CREATE_ACK", "CONTAINER_START_ACK"]),
      bindingInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      actionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      commandInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      ownership: resourceOwnershipSchema,
      inspection: resourceInspectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("prepare_invocation_completed"),
      ...brokerEnvelope,
      commandId: z.string().min(3).max(192),
      attemptId: z.string().min(3).max(192),
      operationId: z.string().min(3).max(192),
      authorityEpochId: z.string().min(3).max(192),
      guardId: z.string().min(3).max(192),
      nativeRequestId: z.string().min(3).max(192),
      bindingInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      actionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      commandInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("native_invocation_planned"),
      ...brokerEnvelope,
      commandId: z.string().min(3).max(192),
      attemptId: z.string().min(3).max(192),
      operationId: z.string().min(3).max(192),
      authorityEpochId: z.string().min(3).max(192),
      executorKey: executorKeySchema,
      guardId: z.string().min(3).max(192),
      nativeRequestId: z.string().min(3).max(192),
      bindingInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      actionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      commandInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      ownership: resourceOwnershipSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("native_invocation_retired"),
      ...brokerEnvelope,
      commandId: z.string().min(3).max(192),
      stopCommandId: z.string().min(3).max(192),
      attemptId: z.string().min(3).max(192),
      operationId: z.string().min(3).max(192),
      authorityEpochId: z.string().min(3).max(192),
      executorKey: executorKeySchema,
      guardId: z.string().min(3).max(192),
      nativeRequestId: z.string().min(3).max(192),
      bindingInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      actionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      commandInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
      nativeOperation: z.literal("CONTAINER_REMOVED"),
      ownership: resourceOwnershipSchema,
      inspection: resourceInspectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("command_terminal"),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      status: commandStatusSchema,
      reason: z.string().max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("attempt_status"),
      ...brokerEnvelope,
      attemptId: z.string(),
      // Old signed records remain unchanged; new status producers bind the command.
      commandId: z.string().optional(),
      status: z.enum(["PREPARED", "RUNNING", "STOPPING", "STOPPED", "NEVER_DISPATCHED", "UNKNOWN"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("command_recovery_hold"),
      ...brokerEnvelope,
      commandId: z.string(),
      attemptId: z.string(),
      expectedCommandHash: z.string().regex(/^[a-f0-9]{64}$/),
      recoveredSequence: z.number().int().positive().safe(),
      recoveredHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
])
export type SupervisorJournalEvent = z.infer<typeof supervisorJournalEventSchema>

export interface CommandState {
  request: SupervisorCommand | null
  attemptId: string
  requestHash: string
  status: CommandStatus
  reason?: string
  receipt: SupervisorReceipt
}

export interface GrantBinding {
  providerId: string
  grantId: string
  grantRequestId?: string
  revoked: boolean
  unsettled?: boolean
}

export interface AttemptState {
  binding: AttemptBinding
  plans: Map<ExecutorKey, ExecutorPlan>
  provider?: ProviderGrantPolicy
  grants: Map<string, GrantBinding>
  // Executor identity journaled BEFORE any executor effect. A crash, failed
  // follow-up append or a delayed daemon response in the create window must
  // still leave a durable candidate that STOP/RECONCILE can inspect.
  planned: Map<ExecutorKey, ResourceOwnership>
  resources: Map<ExecutorKey, ResourceOwnership>
  createAcknowledged: Set<ExecutorKey>
  startPlanned: Set<ExecutorKey>
  startAcknowledged: Set<ExecutorKey>
  nativeAckGuards?: Set<string>
  nativeCreateProofs?: Map<ExecutorKey, ResourceOwnership>
  nativeStartIntents?: Map<
    ExecutorKey,
    Extract<SupervisorJournalEvent, { type: "native_invocation_planned" }>
  >
  receipt: SupervisorReceipt
  status: "PREPARED" | "RUNNING" | "STOPPING" | "STOPPED" | "NEVER_DISPATCHED" | "UNKNOWN"
  createdExecutors: Set<ExecutorKey>
}

export interface InFlightStart {
  stop?: { command: StopCommand; persisted: Promise<void>; revocation?: Promise<void> }
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const supervisorJournalRecordSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().safe(),
    previousHash: hashSchema,
    hash: hashSchema,
    signature: hashSchema,
    payload: supervisorJournalEventSchema,
  })
  .strict()
