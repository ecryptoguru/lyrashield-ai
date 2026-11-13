import { z } from "zod"
import {
  IndependentAuthorityError,
  type AuthorityEvent,
  type AuthorityHead,
} from "./independent-journal"
import type { JournalRecord } from "./journal"
import { executorResourceDescriptorSchema } from "./executor-resource-descriptor"

/**
 * Canonical supervisor executor keys. The tenth key is singular `scanner`
 * (the supervisor brief's plural `scanners` is resolved to singular here:
 * renaming would break existing supervisor journal history and tests; the
 * broker's `ScanSupervisorReceipt.executorKey` TEXT field accepts the
 * singular value, no DB CHECK change).
 */
export const EXECUTOR_KEYS = [
  "http-prepare",
  "staging",
  "relay",
  "repository-token",
  "checkout",
  "sandbox",
  "engine",
  "resolver",
  "scanner",
  "cleanup",
] as const

export const executorKeySchema = z.enum(EXECUTOR_KEYS)
export type ExecutorKey = z.infer<typeof executorKeySchema>

const safeIdSchema = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes(".."), "identifier traversal is not allowed")

const receiptHashSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const MAX_SUPERVISOR_JOURNAL_PAGE_BYTES = 256 * 1024
export const MAX_SUPERVISOR_JOURNAL_RECORD_BYTES = 128 * 1024

/** A cursor is bound to the original signed stream, including its predecessor. */
export const supervisorJournalCursorSchema = z
  .object({
    epochId: safeIdSchema,
    supervisorInstanceId: safeIdSchema,
    afterSequence: z.number().int().nonnegative().safe(),
    afterHash: receiptHashSchema,
    limit: z.number().int().min(1).max(100),
    snapshotSequence: z.number().int().nonnegative().safe().optional(),
    snapshotHash: receiptHashSchema.optional(),
  })
  .strict()
  .refine(
    (cursor) => (cursor.snapshotSequence === undefined) === (cursor.snapshotHash === undefined),
    "snapshot sequence and hash must be supplied together"
  )
export type SupervisorJournalCursor = z.infer<typeof supervisorJournalCursorSchema>

export interface SupervisorJournalPage<T> {
  // Each independently signed wrapper retains the complete original signed
  // envelope at payload.payload. Neither envelope is reconstructed or re-signed.
  records: JournalRecord<AuthorityEvent<JournalRecord<T>>>[]
  // Consumers authenticate this head and the continuous wrapper chain, then stage
  // pages until the final wrapper matches it before applying command dispositions.
  // A later recovery hold must override an earlier positive record.
  // This protocol does not implement or authenticate a broker database consumer.
  snapshotHead: AuthorityHead | null
  nextCursor: SupervisorJournalCursor
  hasMore: boolean
}

export function bindSupervisorJournalSnapshot(
  cursor: SupervisorJournalCursor,
  head: AuthorityHead | null
): SupervisorJournalCursor {
  const sequence = head?.sequence ?? 0
  const hash = head?.recordHash ?? "0".repeat(64)
  if (
    cursor.snapshotSequence !== undefined &&
    (cursor.snapshotSequence !== sequence || cursor.snapshotHash !== hash)
  ) {
    throw new IndependentAuthorityError(
      "CURSOR_CONFLICT",
      "journal snapshot changed; discard staged pages"
    )
  }
  return { ...cursor, snapshotSequence: sequence, snapshotHash: hash }
}

export interface SupervisorJournalReader<T> {
  readCursor(input: unknown): Promise<SupervisorJournalPage<T>>
}

export const supervisorRecoveryRequestSchema = z
  .object({
    epochId: safeIdSchema,
    supervisorInstanceId: safeIdSchema,
    workspaceId: safeIdSchema,
    scanId: safeIdSchema,
    operationId: safeIdSchema,
    attemptId: safeIdSchema,
    commandId: safeIdSchema,
    expectedCommandHash: receiptHashSchema,
  })
  .strict()
export type SupervisorRecoveryRequest = z.infer<typeof supervisorRecoveryRequestSchema>

export interface SupervisorJournalRecovery<T> {
  request: SupervisorRecoveryRequest
  recoveredRecord: JournalRecord<T>
  holdRecord: JournalRecord<T>
  records: JournalRecord<T>[]
}

export interface SupervisorJournalRecoveryPort<T> {
  recoverStored(input: unknown): Promise<SupervisorJournalRecovery<T>>
  recoverPending?(): Promise<SupervisorJournalRecovery<T>>
}

export interface SupervisorRecoveryResult<T> {
  status: "UNKNOWN"
  command: SupervisorCommandResult
  recoveredRecord: JournalRecord<T>
  holdRecord: JournalRecord<T>
}

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)

const environmentSchema = z
  .record(envNameSchema, z.string().max(16_384))
  .refine((value) => Object.keys(value).length <= 96, "too many environment entries")

const containerExecutorSchema = z
  .object({
    kind: z.literal("container"),
    image: z.string().min(1).max(512),
    argv: z.array(z.string().max(32_768)).max(256),
    env: environmentSchema.default({}),
    network: z.string().min(1).max(128),
    cpus: z.number().positive().max(16),
    memoryMb: z.number().int().min(64).max(32_768),
    pidsLimit: z.number().int().min(16).max(8_192),
    readOnly: z.boolean().default(true),
    grantEnvName: envNameSchema.default("LLM_API_KEY"),
    resourceDescriptor: executorResourceDescriptorSchema.optional(),
  })
  .strict()
  .refine(
    (spec) =>
      !spec.resourceDescriptor ||
      (spec.readOnly && spec.image.endsWith(`@${spec.resourceDescriptor.imageDigest}`))
  )

const processExecutorSchema = z
  .object({
    kind: z.literal("process"),
    command: z.string().min(1).max(4_096),
    args: z.array(z.string().max(32_768)).max(256),
    cwd: z.string().min(1).max(4_096),
    cgroupPath: z.string().min(1).max(4_096),
    env: environmentSchema.default({}),
    grantEnvName: envNameSchema.default("LLM_API_KEY"),
  })
  .strict()

export const executorSpecSchema = z.discriminatedUnion("kind", [
  containerExecutorSchema,
  processExecutorSchema,
])
export type ExecutorSpec = z.infer<typeof executorSpecSchema>

export const executorPlanSchema = z
  .object({
    key: executorKeySchema,
    spec: executorSpecSchema,
  })
  .strict()
export type ExecutorPlan = z.infer<typeof executorPlanSchema>

export const attemptBindingSchema = z
  .object({
    attemptId: safeIdSchema,
    scanId: safeIdSchema,
    workspaceId: safeIdSchema,
    operationId: safeIdSchema,
    authorityEpochId: safeIdSchema,
    authorityRevision: z.number().int().nonnegative(),
    workerIdentity: z.string().min(1).max(256),
    billingMode: z.enum(["PAID", "UNMETERED"]),
    expiresAt: z.string().datetime({ offset: true }),
    // Budget-digest binding from the caller/broker (authority). The
    // supervisor validates sha256-hex format only; it never computes dollar
    // budgets itself — dollars→micros exactness and digest equality are the
    // broker's job. Echoed in the journal payload via the attempt binding.
    expectedProviderGrantDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    fundingDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
export type AttemptBinding = z.infer<typeof attemptBindingSchema>

export const providerGrantPolicySchema = z
  .object({
    providerId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    maxRequests: z.number().int().positive().max(100_000),
    costReservationMicros: z.number().int().nonnegative().max(1_000_000_000),
    maxReservedCostMicros: z.number().int().nonnegative().max(1_000_000_000_000),
  })
  .strict()
export type ProviderGrantPolicy = z.infer<typeof providerGrantPolicySchema>

const prepareCommandSchema = z
  .object({
    type: z.literal("PREPARE"),
    commandId: safeIdSchema,
    attempt: attemptBindingSchema,
    executors: z.array(executorPlanSchema).min(1).max(EXECUTOR_KEYS.length),
    provider: providerGrantPolicySchema.optional(),
  })
  .strict()

const startBase = {
  commandId: safeIdSchema,
  attemptId: safeIdSchema,
  executorKey: executorKeySchema,
  expectedReceiptHash: receiptHashSchema,
}

const startPaidCommandSchema = z.object({ ...startBase, type: z.literal("START_PAID") }).strict()
const startUnmeteredCommandSchema = z
  .object({ ...startBase, type: z.literal("START_UNMETERED") })
  .strict()
export const stopCommandSchema = z
  .object({
    type: z.literal("STOP"),
    commandId: safeIdSchema,
    attemptId: safeIdSchema,
    expectedReceiptHash: receiptHashSchema,
  })
  .strict()
export const reconcileCommandSchema = z
  .object({
    type: z.literal("RECONCILE"),
    commandId: safeIdSchema,
    attemptId: safeIdSchema,
    expectedReceiptHash: receiptHashSchema,
  })
  .strict()

export const supervisorCommandSchema = z.discriminatedUnion("type", [
  prepareCommandSchema,
  startPaidCommandSchema,
  startUnmeteredCommandSchema,
  stopCommandSchema,
  reconcileCommandSchema,
])
export type SupervisorCommand = z.infer<typeof supervisorCommandSchema>
export type PrepareCommand = z.infer<typeof prepareCommandSchema>
export type StartCommand =
  z.infer<typeof startPaidCommandSchema> | z.infer<typeof startUnmeteredCommandSchema>
export type StopCommand = z.infer<typeof stopCommandSchema>
export type ReconcileCommand = z.infer<typeof reconcileCommandSchema>

export const resourceOwnershipSchema = z
  .object({
    executorKey: executorKeySchema,
    kind: z.enum(["container", "process"]),
    ownershipId: safeIdSchema,
    containerId: z
      .string()
      .regex(/^[a-f0-9]{12,64}$/)
      .optional(),
    processGroupId: z.number().int().positive().optional(),
    cgroupPath: z.string().min(1).max(4_096).optional(),
    createdAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
export type ResourceOwnership = z.infer<typeof resourceOwnershipSchema>

export const resourceInspectionSchema = z
  .object({
    state: z.enum(["PRESENT", "ABSENT", "UNKNOWN"]),
    running: z.boolean().optional(),
    ownership: resourceOwnershipSchema.optional(),
    detail: z.string().max(512).optional(),
  })
  .strict()
export type ResourceInspection = z.infer<typeof resourceInspectionSchema>

export const commandStatusSchema = z.enum([
  "RECEIVED",
  "PREPARED",
  "EFFECT_PENDING",
  "STARTED",
  "STOPPED",
  "NEVER_DISPATCHED",
  "UNKNOWN",
  "REJECTED",
  "FAILED",
])
export type CommandStatus = z.infer<typeof commandStatusSchema>

export const brokerReceiptTypeSchema = z.enum([
  "COMMAND_ACCEPTED",
  "PREPARE_COMPLETED",
  "EXECUTOR_CREATE_INTENT",
  "EXECUTOR_STARTED",
  "EXECUTOR_EXITED",
  "STOPPED",
  "NEVER_DISPATCHED",
  "UNKNOWN",
])
export type BrokerReceiptType = z.infer<typeof brokerReceiptTypeSchema>

export const supervisorReceiptSchema = z
  .object({
    sequence: z.number().int().positive(),
    hash: receiptHashSchema,
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    supervisorInstanceId: z.string().min(1).max(192),
    receiptType: brokerReceiptTypeSchema,
    evidenceDigest: receiptHashSchema,
    observedAt: z.string().datetime({ offset: true }),
    executorKey: executorKeySchema.optional(),
  })
  .strict()
export type SupervisorReceipt = z.infer<typeof supervisorReceiptSchema>

export const supervisorCommandResultSchema = z
  .object({
    commandId: safeIdSchema,
    attemptId: safeIdSchema,
    status: commandStatusSchema,
    reason: z.string().max(512).optional(),
    receipt: supervisorReceiptSchema,
  })
  .strict()
export type SupervisorCommandResult = z.infer<typeof supervisorCommandResultSchema>

export const providerGrantRequestSchema = z
  .object({
    grantRequestId: safeIdSchema,
    attemptId: safeIdSchema,
    scanId: safeIdSchema,
    workspaceId: safeIdSchema,
    operationId: safeIdSchema,
    authorityEpochId: safeIdSchema,
    authorityRevision: z.number().int().nonnegative(),
    expiresAt: z.string().datetime({ offset: true }),
    providerId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    maxRequests: z.number().int().positive().max(100_000),
    costReservationMicros: z.number().int().nonnegative().max(1_000_000_000),
    maxReservedCostMicros: z.number().int().nonnegative().max(1_000_000_000_000),
  })
  .strict()
export type ProviderGrantRequest = z.infer<typeof providerGrantRequestSchema>

export const providerGrantSchema = z
  .object({
    grantId: safeIdSchema,
    token: z.string().min(32).max(8_192),
    attemptId: safeIdSchema,
    providerId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    expiresAt: z.string().datetime({ offset: true }),
    receipt: receiptHashSchema,
  })
  .strict()
export type ProviderGrant = z.infer<typeof providerGrantSchema>

export const providerGrantRevocationSchema = z
  .object({
    grantId: safeIdSchema,
    attemptId: safeIdSchema,
    reason: z.string().min(1).max(256),
  })
  .strict()
export type ProviderGrantRevocation = z.infer<typeof providerGrantRevocationSchema>

export const providerGrantStatusSchema = z
  .object({
    grantId: safeIdSchema,
    attemptId: safeIdSchema,
    providerId: z.string(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
    requestCount: z.number().int().nonnegative(),
    reservedCostMicros: z.number().int().nonnegative(),
    receipt: receiptHashSchema,
  })
  .strict()
export type ProviderGrantStatus = z.infer<typeof providerGrantStatusSchema>

export interface SupervisorPort {
  issueGrant(request: ProviderGrantRequest): Promise<ProviderGrant>
  findGrantByRequest(grantRequestId: string): Promise<ProviderGrant | null>
  revokeGrant(request: ProviderGrantRevocation): Promise<ProviderGrantStatus>
  inspectGrant(grantId: string): Promise<ProviderGrantStatus | null>
}

export function isSafeRuntimeId(value: string): boolean {
  return safeIdSchema.safeParse(value).success
}
