import { z } from "zod"
import { canonicalJson, sha256Hex } from "./canonical-json"
import { authorityActionSchema } from "./authority-fence"
import { resourceOwnershipSchema } from "./protocol"
const id = z.string().min(3).max(192)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const sandboxToolRetirementProofSchema = z
  .object({
    schema: z.literal("lyrashield-native-tool-retirement/1"),
    phase: z.literal("SANDBOX_TOOL"),
    guardId: id,
    nativeRequestId: id,
    commandId: id,
    stopCommandId: id,
    operationId: id,
    attemptId: id,
    authorityEpochId: id,
    requestId: z.string().uuid(),
    actionChecksum: hash,
    commandInputChecksum: hash,
    bindingInputJson: z.string().max(4096),
    ownership: resourceOwnershipSchema,
    inspection: z.object({ state: z.literal("ABSENT") }).strict(),
    receiptSha256: hash,
  })
  .strict()
/** Actual removal retires uncertainty; it never claims that an exec start was acknowledged. */
export function parseSandboxToolRetirementProof(input: unknown) {
  const proof = sandboxToolRetirementProofSchema.parse(input),
    action = authorityActionSchema.parse(JSON.parse(proof.bindingInputJson))
  const { receiptSha256, ...body } = proof
  if (
    sha256Hex(canonicalJson(body)) !== receiptSha256 ||
    canonicalJson(action) !== proof.bindingInputJson ||
    proof.nativeRequestId !== proof.guardId ||
    action.phase !== "SANDBOX_TOOL" ||
    action.executorKey !== "sandbox" ||
    action.commandId !== proof.commandId ||
    action.actionChecksum !== proof.actionChecksum ||
    action.requestId !== proof.requestId ||
    action.operationId !== proof.operationId ||
    action.attemptId !== proof.attemptId ||
    action.authorityEpochId !== proof.authorityEpochId ||
    proof.ownership.executorKey !== "sandbox" ||
    proof.ownership.kind !== "container" ||
    !/^[a-f0-9]{64}$/.test(proof.ownership.containerId ?? "")
  )
    throw new Error("Native sandbox tool retirement differs")
  return proof
}
