import { z } from "zod"
import {
  authorityActionSchema,
  canonicalJson,
  resourceInspectionSchema,
  resourceOwnershipSchema,
  sha256Hex,
} from "@lyrashield/runtime-control"
import { parseStoredSandboxToolIntent } from "./scan-sandbox-tool-intent"

const id = z.string().min(3).max(192)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const sandboxInvocationAckSchema = z
  .object({
    type: z.literal("native_invocation_ack"),
    supervisorInstanceId: id,
    observedAt: z.string().datetime({ offset: true }),
    commandId: id,
    attemptId: id,
    operationId: id,
    authorityEpochId: id,
    executorKey: z.literal("sandbox"),
    guardId: id,
    nativeRequestId: id,
    nativeOperation: z.literal("SANDBOX_TOOL_START_ACK"),
    requestId: z.string().uuid(),
    execId: hash,
    bindingInputChecksum: hash,
    actionChecksum: hash,
    commandInputChecksum: hash,
    ownership: resourceOwnershipSchema,
    inspection: resourceInspectionSchema,
  })
  .strict()

export const sandboxNativeTargetSchema = z
  .object({ execId: hash, originalGuardId: id, sessionId: z.number().int().positive().safe() })
  .strict()
export const sandboxMutationAckSchema = sandboxInvocationAckSchema
  .omit({ nativeOperation: true, execId: true })
  .extend({
    nativeOperation: z.literal("SANDBOX_TOOL_MUTATION_ACK"),
    nativeMutationId: id,
    nativeReceiptSha256: hash,
    nativeTargets: z.array(sandboxNativeTargetSchema).max(32),
  })
  .strict()
export const sandboxInvocationProofSchema = z.union([
  sandboxInvocationAckSchema,
  sandboxMutationAckSchema,
])

export function verifySandboxInvocationAck(
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
  prepareChecksum: string,
  intent: {
    actionInputJson: string
    actionChecksum: string
    authorityChecksum: string
    requestId: string
    prepareCommandId: string
  }
) {
  const ack = sandboxInvocationProofSchema.parse(event)
  const binding = authorityActionSchema.parse(JSON.parse(guard.bindingInputJson))
  const descriptor = parseStoredSandboxToolIntent(intent)
  if (
    guard.phase !== "SANDBOX_TOOL" ||
    binding.phase !== "SANDBOX_TOOL" ||
    binding.commandId !== guard.commandId ||
    binding.operationId !== guard.operationId ||
    binding.attemptId !== guard.attemptId ||
    binding.authorityEpochId !== guard.authorityEpochId ||
    binding.actionChecksum !== guard.actionChecksum ||
    binding.executorKey !== "sandbox" ||
    guard.executorKey !== "sandbox" ||
    canonicalJson(binding) !== guard.bindingInputJson ||
    sha256Hex(guard.bindingInputJson) !== ack.bindingInputChecksum ||
    ack.guardId !== guard.id ||
    ack.nativeRequestId !== guard.id ||
    ack.operationId !== guard.operationId ||
    ack.attemptId !== guard.attemptId ||
    ack.authorityEpochId !== guard.authorityEpochId ||
    ack.commandId !== guard.commandId ||
    ack.commandInputChecksum !== prepareChecksum ||
    ack.actionChecksum !== guard.actionChecksum ||
    intent.actionChecksum !== guard.actionChecksum ||
    intent.authorityChecksum !== binding.authorityChecksum ||
    intent.prepareCommandId !== binding.commandId ||
    intent.requestId !== ack.requestId ||
    binding.requestId !== ack.requestId ||
    descriptor.request.requestId !== ack.requestId ||
    descriptor.request.binding.operationId !== binding.operationId ||
    descriptor.request.binding.attemptId !== binding.attemptId ||
    descriptor.request.binding.authorityEpochId !== binding.authorityEpochId ||
    descriptor.request.binding.sandboxHandle !== descriptor.ownership.ownershipId ||
    canonicalJson(ack.ownership) !== canonicalJson(descriptor.ownership) ||
    ack.inspection.state !== "PRESENT" ||
    ack.inspection.running !==
      !(
        descriptor.resultKind === "pty/terminate" &&
        descriptor.pty &&
        "stopSandbox" in descriptor.pty &&
        descriptor.pty.stopSandbox === true
      ) ||
    canonicalJson(ack.inspection.ownership) !== canonicalJson(descriptor.ownership)
  )
    throw new Error("Sandbox native invocation acknowledgement differs")
  if (ack.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK") {
    const kind = descriptor.resultKind
    if (
      (kind !== "pty/stdin" && kind !== "pty/terminate") ||
      ack.nativeMutationId !== guard.id ||
      (kind === "pty/stdin" &&
        (ack.nativeTargets.length !== 1 ||
          !descriptor.pty ||
          !("sessionId" in descriptor.pty) ||
          descriptor.pty.sessionId !== ack.nativeTargets[0]!.sessionId)) ||
      new Set(ack.nativeTargets.map((target) => target.sessionId)).size !==
        ack.nativeTargets.length ||
      sha256Hex(
        canonicalJson({
          schema: "lyrashield-native-pty-mutation/1",
          guardId: guard.id,
          actionChecksum: guard.actionChecksum,
          kind,
          targets: ack.nativeTargets,
        })
      ) !== ack.nativeReceiptSha256
    )
      throw new Error("Sandbox native mutation acknowledgement differs")
  } else if (descriptor.resultKind === "pty/stdin" || descriptor.resultKind === "pty/terminate")
    throw new Error("Sandbox mutation cannot create a fresh exec identity")
  return ack
}

/** Retained confirmed original START proofs are required for every targeted PTY. */
export async function verifyOriginalSandboxMutationTargets(
  sql: { query: (text: string, values: string[]) => Promise<{ rows: Record<string, unknown>[] }> },
  input: unknown,
  scope: { operationId: string; attemptId: string; authorityEpochId: string; workspaceId: string }
) {
  const ack = sandboxMutationAckSchema.parse(input)
  for (const target of ack.nativeTargets) {
    const row = (
      await sql.query(
        `SELECT r."proofInputJson",r."proofChecksum",g."bindingInputJson",g.id,g."operationId",g."attemptId",g."authorityEpochId",g.phase,g."commandId",g."executorKey",g."actionChecksum",
      i."actionInputJson",i."authorityChecksum",i."requestId",i."prepareCommandId"
      FROM "ScanExecutionInvocationResolution" r JOIN "ScanExecutionInvocationGuard" g ON g.id=r."guardId"
      JOIN "ScanExecutionActionIntent" i ON i."operationId"=g."operationId" AND i."attemptId"=g."attemptId" AND i."workspaceId"=g."workspaceId" AND i.phase='SANDBOX_TOOL' AND i."requestId"=g."requestId" AND i."actionChecksum"=g."actionChecksum"
      WHERE g.id=$1 AND g."operationId"=$2 AND g."attemptId"=$3 AND g."workspaceId"=$4 AND g."authorityEpochId"=$5`,
        [
          target.originalGuardId,
          scope.operationId,
          scope.attemptId,
          scope.workspaceId,
          scope.authorityEpochId,
        ]
      )
    ).rows[0]
    if (
      !row ||
      typeof row.proofInputJson !== "string" ||
      sha256Hex(row.proofInputJson) !== row.proofChecksum
    )
      throw new Error("Original sandbox PTY proof is unavailable")
    const original = sandboxInvocationAckSchema.parse(JSON.parse(row.proofInputJson))
    if (
      canonicalJson(original) !== row.proofInputJson ||
      original.execId !== target.execId ||
      canonicalJson(original.ownership) !== canonicalJson(ack.ownership) ||
      parseStoredSandboxToolIntent(row as Parameters<typeof parseStoredSandboxToolIntent>[0])
        .resultKind !== "pty/start" ||
      parseInt(sha256Hex(target.originalGuardId).slice(0, 13), 16) + 1 !== target.sessionId
    )
      throw new Error("Original sandbox PTY proof differs")
    verifySandboxInvocationAck(
      original,
      row as Parameters<typeof verifySandboxInvocationAck>[1],
      original.commandInputChecksum,
      row as Parameters<typeof verifySandboxInvocationAck>[3]
    )
  }
}
