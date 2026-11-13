import { createHash, createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import {
  protectedSourceResourceSchema,
  protectedAttachmentsResourceSchema,
  protectedRelayResourceSchema,
  protectedEgressResourceSchema,
} from "@lyrashield/runtime-control/src/executor-resource-descriptor"
import type { ScanPreparationCommandAuthority } from "./scan-dispatch-command-descriptor"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const image = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/)
export const disposableExecutionContextSchema = z
  .object({
    environment: z.literal("DISPOSABLE"),
    databaseIncarnationId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    hostIdentityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    providerFixtureId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
export type DisposableExecutionContext = z.infer<typeof disposableExecutionContextSchema>
export const trustedPreparationHostPolicySchema = z
  .object({
    schema: z.literal("lyrashield-preparation-host-policy/1"),
    authorityEpochId: z.string().min(3).max(192),
    executionContext: disposableExecutionContextSchema,
    engineImage: image,
    sandboxImage: image,
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    engineRevision: z.string().regex(/^[a-f0-9]{40}$/),
    network: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    platformMaxBudgetUsd: z.number().finite().positive().max(1000),
    modelRouting: z
      .object({
        LYRASHIELD_LUNA_LLM: z.string().min(1).max(192),
        LYRASHIELD_SOL_LLM: z.string().min(1).max(192),
      })
      .strict(),
    isolation: z
      .object({
        networkPolicyChecksum: hash,
        seccompPolicyChecksum: hash,
        appArmorProfile: z
          .string()
          .min(1)
          .max(192)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
      })
      .strict(),
    issuerKeyHash: hash,
    issuerKeyId: z.string().url().max(512),
    provider: z
      .object({
        providerId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
        maxRequests: z.number().int().positive().max(100000),
        costReservationMicros: z.number().int().nonnegative().max(1000000000),
      })
      .strict(),
  })
  .strict()
  .refine((policy) => policy.network !== "host" && policy.network !== "bridge")
export type TrustedPreparationHostPolicy = z.infer<typeof trustedPreparationHostPolicySchema>
export const preparationStagingRecordSchema = z
  .object({
    schema: z.literal("lyrashield-preparation-staging/1"),
    issuerKeyHash: hash,
    purpose: z.literal("disposable-preparation"),
    executionContext: disposableExecutionContextSchema,
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    operationId: z.string(),
    attemptId: z.string(),
    scanId: z.string(),
    workspaceId: z.string(),
    authorityEpochId: z.string(),
    executionPlanHash: hash,
    targetSnapshotDigest: hash,
    scopeDigest: hash,
    policyDigest: hash,
    hostPolicyChecksum: hash,
    images: z.object({ engine: image, sandbox: image }).strict(),
    resources: z
      .object({
        source: protectedSourceResourceSchema.nullable(),
        attachments: protectedAttachmentsResourceSchema.nullable(),
        relay: protectedRelayResourceSchema.nullable(),
        egress: protectedEgressResourceSchema,
      })
      .strict(),
    observed: z
      .object({
        inventoryReceiptChecksum: hash,
        runtimeReceiptChecksum: hash,
        inputReceiptChecksum: hash,
        engineEntrypoint: z.tuple([]),
        sandboxEntrypoint: z.tuple([z.literal("docker-entrypoint.sh")]),
      })
      .strict(),
  })
  .strict()
export type PreparationStagingRecord = z.infer<typeof preparationStagingRecordSchema>

export function preparationProofFailure(): never {
  throw new Error("Trusted preparation infrastructure or staged authority is unavailable")
}
export function verifyPreparationStagingRecord(
  input: unknown,
  authority: ScanPreparationCommandAuthority,
  policy: TrustedPreparationHostPolicy,
  publicKeyInput: string,
  observedContext: unknown
) {
  const envelope = z
    .object({
      raw: z.string().min(1),
      result: z
        .object({
          algorithm: z.literal("RS256"),
          keyId: z.string().url(),
          signature: z.string().regex(/^[A-Za-z0-9+/]{512}$/),
        })
        .strict(),
    })
    .strict()
    .parse(input)
  if (Buffer.byteLength(envelope.raw) > 128 * 1024) preparationProofFailure()
  const record = preparationStagingRecordSchema.parse(JSON.parse(envelope.raw))
  const currentContext = disposableExecutionContextSchema.parse(observedContext)
  if (
    canonicalJson(currentContext) !== canonicalJson(policy.executionContext) ||
    canonicalJson(currentContext) !== canonicalJson(record.executionContext)
  )
    preparationProofFailure()
  if (canonicalJson(record) !== envelope.raw) preparationProofFailure()
  const publicKey = createPublicKey(publicKeyInput)
  const keyHash = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    publicKey.asymmetricKeyDetails?.modulusLength !== 3072 ||
    publicKey.asymmetricKeyDetails?.publicExponent !== 65537n ||
    keyHash !== policy.issuerKeyHash ||
    record.issuerKeyHash !== keyHash ||
    envelope.result.keyId !== policy.issuerKeyId
  )
    preparationProofFailure()
  const signatureBytes = Buffer.from(envelope.result.signature, "base64")
  if (
    signatureBytes.toString("base64") !== envelope.result.signature ||
    signatureBytes.length !== 384 ||
    !verify("RSA-SHA256", Buffer.from(envelope.raw), publicKey, signatureBytes)
  )
    preparationProofFailure()
  for (const field of [
    "operationId",
    "attemptId",
    "scanId",
    "workspaceId",
    "authorityEpochId",
  ] as const)
    if (record[field] !== authority.attempt[field]) preparationProofFailure()
  for (const field of [
    "executionPlanHash",
    "targetSnapshotDigest",
    "scopeDigest",
    "policyDigest",
  ] as const)
    if (record[field] !== authority[field]) preparationProofFailure()
  if (
    record.authorityEpochId !== policy.authorityEpochId ||
    record.hostPolicyChecksum !== sha256Hex(canonicalJson(policy)) ||
    record.images.engine !== policy.engineImage ||
    record.images.sandbox !== policy.sandboxImage ||
    Date.parse(record.issuedAt) > Date.now() ||
    Date.parse(record.expiresAt) <= Date.now() ||
    Date.parse(record.expiresAt) > Date.parse(authority.attempt.expiresAt)
  )
    preparationProofFailure()
  return { record, recordChecksum: sha256Hex(envelope.raw) }
}

/** Inputs are supplied by the protected observer inside the locked compiler callback. */
export function buildPreparationStagingRecord(
  authority: ScanPreparationCommandAuthority,
  policy: TrustedPreparationHostPolicy,
  resources: PreparationStagingRecord["resources"],
  observed: PreparationStagingRecord["observed"],
  executionContext: DisposableExecutionContext
): PreparationStagingRecord {
  if (
    canonicalJson(disposableExecutionContextSchema.parse(executionContext)) !==
    canonicalJson(policy.executionContext)
  )
    preparationProofFailure()
  return preparationStagingRecordSchema.parse({
    schema: "lyrashield-preparation-staging/1",
    purpose: "disposable-preparation",
    executionContext,
    issuerKeyHash: policy.issuerKeyHash,
    issuedAt: new Date().toISOString(),
    expiresAt: authority.attempt.expiresAt,
    operationId: authority.attempt.operationId,
    attemptId: authority.attempt.attemptId,
    scanId: authority.attempt.scanId,
    workspaceId: authority.attempt.workspaceId,
    authorityEpochId: authority.attempt.authorityEpochId,
    executionPlanHash: authority.executionPlanHash,
    targetSnapshotDigest: authority.targetSnapshotDigest,
    scopeDigest: authority.scopeDigest,
    policyDigest: authority.policyDigest,
    hostPolicyChecksum: sha256Hex(canonicalJson(policy)),
    images: { engine: policy.engineImage, sandbox: policy.sandboxImage },
    resources,
    observed,
  })
}
