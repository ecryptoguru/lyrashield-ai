import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { z } from "zod"
import {
  canonicalJson,
  resourceOwnershipSchema,
  resourceInspectionSchema,
  executorKeySchema,
  nativeRemovalProofSchema,
  parseNativeRemovalProof,
  sha256Hex,
  sandboxToolRetirementProofSchema,
} from "@lyrashield/runtime-control"
import { receiptFailure } from "./scan-supervisor-receipt-ingestion-verifier"
import { verifySandboxToolRetirement } from "./scan-sandbox-tool-retirement"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(3).max(192)
export const nativeRetirementSchema = z
  .object({
    type: z.literal("native_invocation_retired"),
    phase: z.enum(["EXECUTOR_CREATE", "EXECUTOR_START", "SANDBOX_TOOL"]).optional(),
    supervisorInstanceId: id,
    observedAt: z.string().datetime({ offset: true }),
    commandId: id,
    stopCommandId: id,
    attemptId: id,
    operationId: id,
    authorityEpochId: id,
    executorKey: executorKeySchema,
    guardId: id,
    nativeRequestId: id,
    bindingInputChecksum: hash,
    actionChecksum: hash,
    commandInputChecksum: hash,
    nativeOperation: z.literal("CONTAINER_REMOVED"),
    ownership: resourceOwnershipSchema,
    inspection: resourceInspectionSchema,
    nativeRemovalProof: nativeRemovalProofSchema.optional(),
    nativeToolRetirementProof: sandboxToolRetirementProofSchema.optional(),
  })
  .strict()

type Guard = {
  id: string
  operationId: string
  attemptId: string
  authorityEpochId: string
  phase: string
  commandId: string
  executorKey: string | null
  actionChecksum: string
  bindingInputJson: string
}

export function verifyNativeRetirement(
  event: unknown,
  guard: Guard,
  commandChecksum: string,
  originalPlan: unknown
) {
  const retired = nativeRetirementSchema.parse(event)
  if (retired.phase === "SANDBOX_TOOL")
    return verifySandboxToolRetirement(
      retired,
      guard,
      commandChecksum,
      originalPlan as Parameters<typeof verifySandboxToolRetirement>[3]
    )
  const planned = z
    .object({
      type: z.literal("native_invocation_planned"),
      phase: z.string().optional(),
      guardId: id,
      nativeRequestId: id,
      commandId: id,
      attemptId: id,
      operationId: id,
      authorityEpochId: id,
      executorKey: executorKeySchema,
      bindingInputChecksum: hash,
      actionChecksum: hash,
      commandInputChecksum: hash,
      ownership: resourceOwnershipSchema,
    })
    .passthrough()
    .parse(originalPlan)
  const phase = retired.phase ?? "EXECUTOR_START"
  const ownership = retired.ownership
  if (
    retired.nativeToolRetirementProof !== undefined ||
    phase !== guard.phase ||
    phase !== (planned.phase ?? "EXECUTOR_START") ||
    retired.guardId !== guard.id ||
    retired.nativeRequestId !== guard.id ||
    planned.guardId !== guard.id ||
    planned.nativeRequestId !== guard.id ||
    retired.operationId !== guard.operationId ||
    retired.attemptId !== guard.attemptId ||
    retired.authorityEpochId !== guard.authorityEpochId ||
    retired.commandId !== guard.commandId ||
    retired.executorKey !== guard.executorKey ||
    retired.actionChecksum !== guard.actionChecksum ||
    commandChecksum !== guard.actionChecksum ||
    retired.commandInputChecksum !== commandChecksum ||
    retired.bindingInputChecksum !== sha256Hex(guard.bindingInputJson) ||
    canonicalJson(retired.inspection) !== canonicalJson({ state: "ABSENT" }) ||
    ownership.kind !== "container" ||
    !/^[a-f0-9]{64}$/.test(ownership.containerId ?? "") ||
    ownership.executorKey !== guard.executorKey ||
    ownership.ownershipId !==
      `own_${sha256Hex(`${guard.attemptId}\0${guard.commandId}\0${guard.executorKey}`).slice(0, 40)}` ||
    [
      "commandId",
      "attemptId",
      "operationId",
      "authorityEpochId",
      "executorKey",
      "bindingInputChecksum",
      "actionChecksum",
      "commandInputChecksum",
    ].some((key) => Reflect.get(planned, key) !== Reflect.get(retired, key))
  )
    receiptFailure("SUPERVISOR_NATIVE_RETIREMENT_MISMATCH")
  if (phase === "EXECUTOR_CREATE") {
    const proof = parseNativeRemovalProof(retired.nativeRemovalProof)
    if (
      planned.ownership.containerId !== undefined ||
      planned.ownership.ownershipId !== ownership.ownershipId ||
      planned.ownership.executorKey !== ownership.executorKey ||
      proof.guardId !== guard.id ||
      proof.commandId !== retired.commandId ||
      proof.stopCommandId !== retired.stopCommandId ||
      proof.bindingInputChecksum !== retired.bindingInputChecksum ||
      proof.actionChecksum !== retired.actionChecksum ||
      proof.operationId !== retired.operationId ||
      proof.attemptId !== retired.attemptId ||
      proof.authorityEpochId !== retired.authorityEpochId ||
      canonicalJson(proof.ownership) !== canonicalJson(ownership)
    )
      receiptFailure("SUPERVISOR_NATIVE_RETIREMENT_MISMATCH")
  } else if (
    retired.nativeRemovalProof !== undefined ||
    canonicalJson(planned.ownership) !== canonicalJson(ownership)
  )
    receiptFailure("SUPERVISOR_NATIVE_RETIREMENT_MISMATCH")
  return retired
}

/** The snapshot consumer has authenticated the original/wrapper chain and confirmed head. */
export async function resolveNativeRetirementReceipt(
  client: pg.PoolClient,
  event: unknown,
  receiptId: string,
  commandChecksum: string
) {
  const parsed = nativeRetirementSchema.parse(event)
  const guard = (
    await client.query<Guard>(
      `SELECT id,"operationId","attemptId","authorityEpochId",phase,"commandId","executorKey","actionChecksum","bindingInputJson"
    FROM "ScanExecutionInvocationGuard" WHERE id=$1 AND "workspaceId"=app.current_workspace_id()`,
      [parsed.guardId]
    )
  ).rows[0]
  const plan =
    parsed.phase === "SANDBOX_TOOL"
      ? (
          await client.query<Parameters<typeof verifySandboxToolRetirement>[3]>(
            `SELECT "actionInputJson","actionChecksum","authorityChecksum","requestId","prepareCommandId" FROM "ScanExecutionActionIntent"
       WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=app.current_workspace_id() AND "authorityEpochId"=$3 AND phase='SANDBOX_TOOL'
       AND "requestId"=$4 AND "actionChecksum"=$5`,
            [
              guard?.operationId,
              guard?.attemptId,
              guard?.authorityEpochId,
              guard && JSON.parse(guard.bindingInputJson).requestId,
              guard?.actionChecksum,
            ]
          )
        ).rows
      : (
          await client.query<{ originalInputJson: string }>(
            `SELECT p."originalInputJson" FROM "ScanSupervisorJournalRecord" p
    JOIN "ScanSupervisorJournalRecord" r ON r.id=(SELECT "journalRecordId" FROM "ScanSupervisorReceipt" WHERE id=$1)
    WHERE p."streamId"=r."streamId" AND p."workspaceId"=r."workspaceId" AND p."operationId"=r."operationId" AND p."attemptId"=r."attemptId"
      AND p.sequence<r.sequence AND p."originalInputJson"::jsonb#>>'{payload,type}'='native_invocation_planned'
      AND p."originalInputJson"::jsonb#>>'{payload,guardId}'=$2 ORDER BY p.sequence DESC LIMIT 2`,
            [receiptId, parsed.guardId]
          )
        ).rows
  if (!guard || plan.length !== 1) receiptFailure("SUPERVISOR_NATIVE_RETIREMENT_MISMATCH")
  const proof = verifyNativeRetirement(
    parsed,
    guard,
    commandChecksum,
    parsed.phase === "SANDBOX_TOOL"
      ? plan[0]
      : JSON.parse((plan[0] as { originalInputJson: string }).originalInputJson).payload
  )
  const proofInputJson = canonicalJson(proof),
    proofChecksum = sha256Hex(proofInputJson)
  const existing = (
    await client.query<{ receiptId: string; proofInputJson: string; proofChecksum: string }>(
      `SELECT "receiptId","proofInputJson","proofChecksum" FROM "ScanExecutionInvocationResolution" WHERE "guardId"=$1`,
      [guard.id]
    )
  ).rows
  if (existing.length) {
    if (
      existing[0]!.receiptId !== receiptId ||
      existing[0]!.proofInputJson !== proofInputJson ||
      existing[0]!.proofChecksum !== proofChecksum
    )
      receiptFailure("SUPERVISOR_NATIVE_INVOCATION_PROOF_CONFLICT")
    return
  }
  await client.query(
    `INSERT INTO "ScanExecutionInvocationResolution"(id,"guardId","receiptId","proofInputJson","proofChecksum") VALUES($1,$2,$3,$4,$5)`,
    [createId(), guard.id, receiptId, proofInputJson, proofChecksum]
  )
}
