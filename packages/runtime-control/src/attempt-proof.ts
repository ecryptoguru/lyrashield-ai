import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto"
import { z } from "zod"
import { canonicalJson, sha256Hex } from "./canonical-json"
import { attemptBindingSchema, executorKeySchema, supervisorCommandSchema } from "./protocol"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const supervisorAttemptProofInputSchema = z
  .object({
    operationId: id,
    attemptId: id,
    workspaceId: id,
    scanId: id,
    authorityEpochId: id,
    commandId: id,
    type: z.enum(["START_PAID", "START_UNMETERED", "STOP", "RECONCILE"]),
    executorKey: executorKeySchema.optional(),
    challenge: hash,
  })
  .strict()
  .refine((input) => input.type.startsWith("START_") === (input.executorKey !== undefined))
export type SupervisorAttemptProofInput = z.infer<typeof supervisorAttemptProofInputSchema>
export const supervisorAttemptProofSchema = z
  .object({
    purpose: z.literal("lyrashield-supervisor-attempt-proof/2"),
    input: supervisorAttemptProofInputSchema,
    binding: attemptBindingSchema,
    supervisorInstanceId: id,
    prepareChecksum: hash,
    preparedCompleted: z.boolean(),
    status: z.enum(["PREPARED", "RUNNING", "STOPPING", "UNKNOWN", "STOPPED", "NEVER_DISPATCHED"]),
    command: supervisorCommandSchema,
    commandChecksum: hash,
    headInputChecksum: hash,
    headSequence: z.number().int().positive().safe(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict()
export type SupervisorAttemptProof = z.infer<typeof supervisorAttemptProofSchema>

function proofKey(pem: string, privateKey: boolean): KeyObject {
  try {
    if (
      Buffer.byteLength(pem) > 1024 ||
      !pem.startsWith(privateKey ? "-----BEGIN PRIVATE KEY-----" : "-----BEGIN PUBLIC KEY-----")
    )
      throw new Error()
    const key = privateKey ? createPrivateKey(pem) : createPublicKey(pem)
    if (key.asymmetricKeyType !== "ed25519" || key.type !== (privateKey ? "private" : "public"))
      throw new Error()
    return key
  } catch {
    throw new Error("Attempt proof key is unavailable")
  }
}

/** Validate an installed public pin without accepting a private key or another algorithm. */
export function validateSupervisorAttemptProofPublicKey(publicKey: string): string {
  return proofKey(publicKey, false).export({ format: "pem", type: "spki" }).toString()
}

export function supervisorAttemptProofPublicKey(privateKey: string): string {
  return createPublicKey(proofKey(privateKey, true))
    .export({ format: "pem", type: "spki" })
    .toString()
}

export function signSupervisorAttemptProof(
  input: Omit<SupervisorAttemptProof, "signature">,
  authority: { privateKey: string }
): SupervisorAttemptProof {
  const unsigned = supervisorAttemptProofSchema.omit({ signature: true }).parse(input)
  return supervisorAttemptProofSchema.parse({
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalJson(unsigned)),
      proofKey(authority.privateKey, true)
    ).toString("hex"),
  })
}

export function verifySupervisorAttemptProof(
  value: unknown,
  expected: SupervisorAttemptProofInput,
  authority: { publicKey: string; supervisorInstanceId: string },
  now = new Date()
): SupervisorAttemptProof {
  const bytes = canonicalJson(value)
  if (Buffer.byteLength(bytes) > 16 * 1024) throw new Error("Attempt proof exceeds its bound")
  const proof = supervisorAttemptProofSchema.parse(JSON.parse(bytes))
  const { signature, ...unsigned } = proof
  const signatureValid = verify(
    null,
    Buffer.from(canonicalJson(unsigned)),
    proofKey(authority.publicKey, false),
    Buffer.from(signature, "hex")
  )
  const binding = proof.binding
  const command = proof.command
  if (
    !signatureValid ||
    canonicalJson(proof.input) !==
      canonicalJson(supervisorAttemptProofInputSchema.parse(expected)) ||
    proof.supervisorInstanceId !== authority.supervisorInstanceId ||
    binding.operationId !== expected.operationId ||
    binding.attemptId !== expected.attemptId ||
    binding.workspaceId !== expected.workspaceId ||
    binding.scanId !== expected.scanId ||
    binding.authorityEpochId !== expected.authorityEpochId ||
    command.type === "PREPARE" ||
    command.type !== expected.type ||
    command.commandId !== expected.commandId ||
    command.attemptId !== expected.attemptId ||
    ("executorKey" in command && command.executorKey !== expected.executorKey) ||
    proof.commandChecksum !== sha256Hex(canonicalJson(command)) ||
    Date.parse(proof.issuedAt) > now.getTime() ||
    Date.parse(proof.expiresAt) <= now.getTime() ||
    Date.parse(proof.expiresAt) - Date.parse(proof.issuedAt) > 10_000 ||
    Date.parse(proof.expiresAt) <= Date.parse(proof.issuedAt) ||
    (expected.type.startsWith("START_") &&
      (!proof.preparedCompleted ||
        !["PREPARED", "RUNNING"].includes(proof.status) ||
        Date.parse(binding.expiresAt) <= now.getTime() ||
        (expected.type === "START_PAID"
          ? binding.billingMode !== "PAID"
          : binding.billingMode !== "UNMETERED")))
  )
    throw new Error("Attempt proof authority is unavailable")
  return proof
}
