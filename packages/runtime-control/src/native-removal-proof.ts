import { z } from "zod"
import { resourceOwnershipSchema } from "./protocol"
import { canonicalJson, sha256Hex } from "./canonical-json"

export const nativeRemovalProofSchema = z
  .object({
    schema: z.literal("lyrashield-native-removal/1"),
    phase: z.literal("EXECUTOR_CREATE"),
    guardId: z.string().min(3).max(192),
    nativeRequestId: z.string().min(3).max(192),
    commandId: z.string().min(3).max(192),
    stopCommandId: z.string().min(3).max(192),
    operationId: z.string().min(3).max(192),
    attemptId: z.string().min(3).max(192),
    authorityEpochId: z.string().min(3).max(192),
    bindingInputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    actionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    ownership: resourceOwnershipSchema,
    inspection: z.object({ state: z.literal("ABSENT") }).strict(),
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export function parseNativeRemovalProof(value: unknown) {
  const proof = nativeRemovalProofSchema.parse(value)
  const { receiptSha256, ...body } = proof
  if (
    sha256Hex(canonicalJson(body)) !== receiptSha256 ||
    proof.guardId !== proof.nativeRequestId ||
    !/^[a-f0-9]{64}$/.test(proof.ownership.containerId ?? "")
  )
    throw new Error("Original native removal proof differs")
  return proof
}
