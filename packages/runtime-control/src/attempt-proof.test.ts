import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson, sha256Hex } from "./canonical-json"
import {
  signSupervisorAttemptProof,
  supervisorAttemptProofPublicKey,
  validateSupervisorAttemptProofPublicKey,
  supervisorAttemptProofInputSchema,
  verifySupervisorAttemptProof,
  type SupervisorAttemptProof,
} from "./attempt-proof"

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
})
const now = new Date("2026-11-14T12:00:00.000Z")
const input = {
  operationId: "operation-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  scanId: "scan-1",
  authorityEpochId: "epoch-1",
  commandId: "command-1",
  type: "START_PAID" as const,
  executorKey: "engine" as const,
  challenge: "a".repeat(64),
}
function proof() {
  const command = {
    type: input.type,
    commandId: input.commandId,
    attemptId: input.attemptId,
    executorKey: input.executorKey,
    expectedReceiptHash: "b".repeat(64),
  }
  return signSupervisorAttemptProof(
    {
      purpose: "lyrashield-supervisor-attempt-proof/2",
      input,
      binding: {
        attemptId: input.attemptId,
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        scanId: input.scanId,
        authorityEpochId: input.authorityEpochId,
        authorityRevision: 1,
        workerIdentity: "worker-1",
        billingMode: "PAID",
        expiresAt: "2026-11-14T12:01:00.000Z",
      },
      supervisorInstanceId: "supervisor-1",
      prepareChecksum: "c".repeat(64),
      preparedCompleted: true,
      status: "PREPARED",
      command,
      commandChecksum: sha256Hex(canonicalJson(command)),
      headInputChecksum: "d".repeat(64),
      headSequence: 3,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10_000).toISOString(),
    },
    { privateKey }
  )
}
const authority = { publicKey, supervisorInstanceId: "supervisor-1" }
function resign(value: SupervisorAttemptProof) {
  const { signature, ...unsigned } = value
  expect(signature).toHaveLength(128)
  return signSupervisorAttemptProof(unsigned, { privateKey })
}
describe("scoped immutable attempt proof", () => {
  it("pins Ed25519 public authority and rejects private keys, other keys and legacy HMAC proofs", () => {
    expect(supervisorAttemptProofPublicKey(privateKey)).toBe(publicKey)
    expect(validateSupervisorAttemptProofPublicKey(publicKey)).toBe(publicKey)
    expect(() => validateSupervisorAttemptProofPublicKey(privateKey)).toThrow(
      "Attempt proof key is unavailable"
    )
    const foreign = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    })
    expect(() =>
      verifySupervisorAttemptProof(
        proof(),
        input,
        { ...authority, publicKey: foreign.publicKey },
        now
      )
    ).toThrow()
    expect(() =>
      verifySupervisorAttemptProof(
        { ...proof(), purpose: "lyrashield-supervisor-attempt-proof/1", signature: "a".repeat(64) },
        input,
        authority,
        now
      )
    ).toThrow()
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    })
    expect(() => validateSupervisorAttemptProofPublicKey(rsa.publicKey)).toThrow(
      "Attempt proof key is unavailable"
    )
  })
  it("verifies only the exact scoped command and challenge", () => {
    expect(verifySupervisorAttemptProof(proof(), input, authority, now).commandChecksum).toBe(
      proof().commandChecksum
    )
    expect(() =>
      verifySupervisorAttemptProof(proof(), { ...input, challenge: "f".repeat(64) }, authority, now)
    ).toThrow()
    expect(() =>
      verifySupervisorAttemptProof(
        proof(),
        { ...input, workspaceId: "workspace-2" },
        authority,
        now
      )
    ).toThrow()
    expect(() =>
      verifySupervisorAttemptProof({ ...proof(), headSequence: 4 }, input, authority, now)
    ).toThrow()
  })
  it.each(["expired", "future", "long", "incomplete", "unmetered", "foreign-command"])(
    "rejects signed but invalid authority (%s)",
    (change) => {
      const value = proof()
      if (change === "expired") value.expiresAt = now.toISOString()
      if (change === "future") value.issuedAt = new Date(now.getTime() + 1).toISOString()
      if (change === "long") value.expiresAt = new Date(now.getTime() + 10_001).toISOString()
      if (change === "incomplete") value.preparedCompleted = false
      if (change === "unmetered") value.binding.billingMode = "UNMETERED"
      if (change === "foreign-command") value.command.commandId = "command-foreign"
      expect(() => verifySupervisorAttemptProof(resign(value), input, authority, now)).toThrow()
    }
  )
  it("accepts cleanup for expired attempts without a completed PREPARE and rejects START without an executor", () => {
    const value = proof()
    const cleanup = { ...input, executorKey: undefined }
    value.input = { ...cleanup, type: "STOP" }
    value.binding.expiresAt = "2026-11-14T11:00:00.000Z"
    value.preparedCompleted = false
    value.status = "UNKNOWN"
    value.command = {
      type: "STOP",
      commandId: input.commandId,
      attemptId: input.attemptId,
      expectedReceiptHash: "b".repeat(64),
    }
    value.commandChecksum = sha256Hex(canonicalJson(value.command))
    expect(
      verifySupervisorAttemptProof(resign(value), value.input, authority, now).command.type
    ).toBe("STOP")
    expect(() =>
      supervisorAttemptProofInputSchema.parse({ ...cleanup, type: "START_PAID" })
    ).toThrow()
  })
})
