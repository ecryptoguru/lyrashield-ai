import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { z } from "zod"
import {
  canonicalJson,
  resourceOwnershipSchema,
  resourceInspectionSchema,
  executorKeySchema,
} from "@lyrashield/runtime-control"
import { sha256Hex } from "./scan-supervisor-receipt-verifier"
import { receiptFailure } from "./scan-supervisor-receipt-ingestion-verifier"
import {
  sandboxInvocationProofSchema,
  verifySandboxInvocationAck,
  verifyOriginalSandboxMutationTargets,
} from "./scan-sandbox-tool-ack"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(3).max(192)
export const nativeInvocationAckSchema = z
  .object({
    type: z.literal("native_invocation_ack"),
    supervisorInstanceId: id,
    observedAt: z.string().datetime({ offset: true }),
    commandId: id,
    attemptId: id,
    operationId: id,
    authorityEpochId: id,
    executorKey: executorKeySchema,
    guardId: id,
    nativeRequestId: id,
    nativeOperation: z.enum(["CONTAINER_CREATE_ACK", "CONTAINER_START_ACK"]),
    bindingInputChecksum: hash,
    actionChecksum: hash,
    commandInputChecksum: hash,
    ownership: resourceOwnershipSchema,
    inspection: resourceInspectionSchema,
  })
  .strict()

export const prepareInvocationCompletedSchema = nativeInvocationAckSchema
  .omit({ executorKey: true, nativeOperation: true, ownership: true, inspection: true })
  .extend({ type: z.literal("prepare_invocation_completed") })
  .strict()
const invocationProofSchema = z.union([
  nativeInvocationAckSchema,
  sandboxInvocationProofSchema,
  prepareInvocationCompletedSchema,
])

export function verifyNativeInvocationAck(
  event: unknown,
  guard: {
    id: string
    operationId: string
    attemptId: string
    authorityEpochId: string
    phase: string
    commandId: string
    executorKey: string | null
    actionChecksum: string
    bindingInputJson: string
  },
  commandInputChecksum: string
) {
  const ack = nativeInvocationAckSchema.parse(event)
  const ownership = ack.ownership
  if (
    ack.guardId !== guard.id ||
    ack.nativeRequestId !== guard.id ||
    ack.operationId !== guard.operationId ||
    ack.attemptId !== guard.attemptId ||
    ack.authorityEpochId !== guard.authorityEpochId ||
    ack.commandId !== guard.commandId ||
    ack.executorKey !== guard.executorKey ||
    ack.actionChecksum !== guard.actionChecksum ||
    ack.commandInputChecksum !== commandInputChecksum ||
    guard.actionChecksum !== commandInputChecksum ||
    sha256Hex(guard.bindingInputJson) !== ack.bindingInputChecksum ||
    guard.phase !==
      (ack.nativeOperation === "CONTAINER_CREATE_ACK" ? "EXECUTOR_CREATE" : "EXECUTOR_START") ||
    ownership.kind !== "container" ||
    !/^[a-f0-9]{64}$/.test(ownership.containerId ?? "") ||
    ownership.executorKey !== guard.executorKey ||
    ownership.ownershipId !==
      `own_${sha256Hex(`${guard.attemptId}\0${guard.commandId}\0${guard.executorKey}`).slice(0, 40)}` ||
    ack.inspection.state !== "PRESENT" ||
    ack.inspection.running !== (ack.nativeOperation === "CONTAINER_START_ACK") ||
    canonicalJson(ack.inspection.ownership ?? null) !== canonicalJson(ownership)
  )
    receiptFailure("SUPERVISOR_NATIVE_INVOCATION_PROOF_MISMATCH")
  return ack
}

/** Called only after source+head authentication and receipt retention in the same fenced transaction.
 * Releasing this completed original invocation does not release any paid/physical UNKNOWN hold. */
export async function resolveNativeInvocationReceipt(
  client: pg.PoolClient,
  event: unknown,
  receiptId: string,
  commandInputChecksum: string
) {
  const parsed = invocationProofSchema.parse(event)
  const result = await client.query<Parameters<typeof verifyNativeInvocationAck>[1]>(
    `SELECT id,"operationId","attemptId","authorityEpochId",phase,"commandId","executorKey","actionChecksum","bindingInputJson"
     FROM "ScanExecutionInvocationGuard" WHERE id=$1 AND "workspaceId"=app.current_workspace_id()`,
    [parsed.guardId]
  )
  if (result.rows.length !== 1) receiptFailure("SUPERVISOR_NATIVE_INVOCATION_GUARD_UNAVAILABLE")
  const guard = result.rows[0]!
  const toolIntent =
    parsed.type === "native_invocation_ack" &&
    (parsed.nativeOperation === "SANDBOX_TOOL_START_ACK" ||
      parsed.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK")
      ? (
          await client.query<{
            actionInputJson: string
            actionChecksum: string
            authorityChecksum: string
            requestId: string
            prepareCommandId: string
          }>(
            `SELECT "actionInputJson","actionChecksum","authorityChecksum","requestId","prepareCommandId" FROM "ScanExecutionActionIntent"
       WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=app.current_workspace_id() AND phase='SANDBOX_TOOL' AND "requestId"=$3 AND "actionChecksum"=$4`,
            [guard.operationId, guard.attemptId, parsed.requestId, guard.actionChecksum]
          )
        ).rows[0]
      : undefined
  if (
    parsed.type === "native_invocation_ack" &&
    (parsed.nativeOperation === "SANDBOX_TOOL_START_ACK" ||
      parsed.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK") &&
    !toolIntent
  )
    receiptFailure("SUPERVISOR_NATIVE_INVOCATION_GUARD_UNAVAILABLE")
  const ack =
    parsed.type === "native_invocation_ack" &&
    (parsed.nativeOperation === "SANDBOX_TOOL_START_ACK" ||
      parsed.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK")
      ? verifySandboxInvocationAck(parsed, guard, commandInputChecksum, toolIntent!)
      : parsed.type === "native_invocation_ack"
        ? verifyNativeInvocationAck(parsed, guard, commandInputChecksum)
        : verifyPrepareInvocationCompleted(parsed, guard, commandInputChecksum)
  if (ack.type === "native_invocation_ack" && ack.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK")
    await verifyOriginalSandboxMutationTargets(client, ack, {
      ...guard,
      workspaceId: (await client.query("SELECT app.current_workspace_id() AS workspace", []))
        .rows[0].workspace,
    })
  const proofInputJson = canonicalJson(ack),
    proofChecksum = sha256Hex(proofInputJson)
  const existing = await client.query<{
    receiptId: string
    proofInputJson: string
    proofChecksum: string
  }>(
    'SELECT "receiptId","proofInputJson","proofChecksum" FROM "ScanExecutionInvocationResolution" WHERE "guardId"=$1',
    [ack.guardId]
  )
  if (existing.rows.length) {
    if (
      existing.rows[0]!.receiptId !== receiptId ||
      existing.rows[0]!.proofInputJson !== proofInputJson ||
      existing.rows[0]!.proofChecksum !== proofChecksum
    )
      receiptFailure("SUPERVISOR_NATIVE_INVOCATION_PROOF_CONFLICT")
    return
  }
  await client.query(
    `INSERT INTO "ScanExecutionInvocationResolution"(id,"guardId","receiptId","proofInputJson","proofChecksum") VALUES($1,$2,$3,$4,$5)`,
    [createId(), ack.guardId, receiptId, proofInputJson, proofChecksum]
  )
}

export function verifyPrepareInvocationCompleted(
  event: unknown,
  guard: Parameters<typeof verifyNativeInvocationAck>[1],
  commandInputChecksum: string
) {
  const proof = prepareInvocationCompletedSchema.parse(event)
  if (
    proof.guardId !== guard.id ||
    proof.nativeRequestId !== guard.id ||
    proof.operationId !== guard.operationId ||
    proof.attemptId !== guard.attemptId ||
    proof.authorityEpochId !== guard.authorityEpochId ||
    proof.commandId !== guard.commandId ||
    proof.actionChecksum !== guard.actionChecksum ||
    proof.commandInputChecksum !== commandInputChecksum ||
    guard.actionChecksum !== commandInputChecksum ||
    sha256Hex(guard.bindingInputJson) !== proof.bindingInputChecksum ||
    guard.phase !== "PREPARE" ||
    guard.executorKey !== null
  )
    receiptFailure("SUPERVISOR_PREPARATION_INVOCATION_PROOF_MISMATCH")
  return proof
}
