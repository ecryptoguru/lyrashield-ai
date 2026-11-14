import { z } from "zod"
import {
  canonicalJson,
  sha256Hex,
  authorityActionSchema,
  resourceOwnershipSchema,
  resourceInspectionSchema,
  sandboxToolRetirementProofSchema,
  parseSandboxToolRetirementProof,
} from "@lyrashield/runtime-control"
import { parseStoredSandboxToolIntent } from "./scan-sandbox-tool-intent"
const id = z.string().min(3).max(192),
  hash = z.string().regex(/^[a-f0-9]{64}$/)
export const sandboxToolRetirementSchema = z
  .object({
    type: z.literal("native_invocation_retired"),
    phase: z.literal("SANDBOX_TOOL"),
    supervisorInstanceId: id,
    observedAt: z.string().datetime({ offset: true }),
    commandId: id,
    stopCommandId: id,
    attemptId: id,
    operationId: id,
    authorityEpochId: id,
    executorKey: z.literal("sandbox"),
    guardId: id,
    nativeRequestId: id,
    bindingInputChecksum: hash,
    actionChecksum: hash,
    commandInputChecksum: hash,
    nativeOperation: z.literal("CONTAINER_REMOVED"),
    ownership: resourceOwnershipSchema,
    inspection: resourceInspectionSchema,
    nativeToolRetirementProof: sandboxToolRetirementProofSchema,
  })
  .strict()
export function verifySandboxToolRetirement(
  input: unknown,
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
  const event = sandboxToolRetirementSchema.parse(input),
    proof = parseSandboxToolRetirementProof(event.nativeToolRetirementProof),
    action = authorityActionSchema.parse(JSON.parse(guard.bindingInputJson)),
    descriptor = parseStoredSandboxToolIntent(intent)
  if (
    guard.phase !== "SANDBOX_TOOL" ||
    guard.executorKey !== "sandbox" ||
    action.phase !== "SANDBOX_TOOL" ||
    action.executorKey !== "sandbox" ||
    action.operationId !== guard.operationId ||
    action.attemptId !== guard.attemptId ||
    action.authorityEpochId !== guard.authorityEpochId ||
    action.commandId !== guard.commandId ||
    action.actionChecksum !== guard.actionChecksum ||
    canonicalJson(action) !== guard.bindingInputJson ||
    proof.bindingInputJson !== guard.bindingInputJson ||
    proof.guardId !== guard.id ||
    proof.actionChecksum !== guard.actionChecksum ||
    event.guardId !== guard.id ||
    event.nativeRequestId !== guard.id ||
    event.bindingInputChecksum !== sha256Hex(guard.bindingInputJson) ||
    event.actionChecksum !== guard.actionChecksum ||
    event.commandInputChecksum !== prepareChecksum ||
    proof.commandInputChecksum !== prepareChecksum ||
    event.commandId !== guard.commandId ||
    event.stopCommandId !== proof.stopCommandId ||
    event.operationId !== guard.operationId ||
    event.attemptId !== guard.attemptId ||
    event.authorityEpochId !== guard.authorityEpochId ||
    canonicalJson(event.inspection) !== canonicalJson({ state: "ABSENT" }) ||
    canonicalJson(event.ownership) !== canonicalJson(proof.ownership) ||
    canonicalJson(event.ownership) !== canonicalJson(descriptor.ownership) ||
    intent.actionChecksum !== guard.actionChecksum ||
    intent.requestId !== action.requestId ||
    proof.requestId !== action.requestId ||
    intent.prepareCommandId !== action.commandId ||
    intent.authorityChecksum !== action.authorityChecksum ||
    descriptor.request.requestId !== action.requestId ||
    descriptor.request.binding.operationId !== guard.operationId ||
    descriptor.request.binding.attemptId !== guard.attemptId ||
    descriptor.request.binding.authorityEpochId !== guard.authorityEpochId ||
    descriptor.request.binding.sandboxHandle !== descriptor.ownership.ownershipId
  )
    throw new Error("Sandbox tool retirement differs from original immutable authority")
  return event
}
