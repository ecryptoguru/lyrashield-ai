import { createHash, createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import {
  canonicalJson,
  sha256Hex,
  installedExecutionAuthoritySchema,
  requireCurrentPreparationDelegation,
} from "@lyrashield/runtime-control"
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
const preparationHostPolicyBase = z
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
export const trustedPreparationHostPolicySchema = z
  .discriminatedUnion("schema", [
    preparationHostPolicyBase,
    preparationHostPolicyBase.extend({
      schema: z.literal("lyrashield-preparation-host-policy/2"),
      executionContext: z.object({ environment: z.literal("PRODUCTION") }).strict(),
    }),
  ])
  .refine((policy) => policy.network !== "host" && policy.network !== "bridge")
export const productionExecutionContextSchema = z
  .object({
    environment: z.literal("PRODUCTION"),
    installed: installedExecutionAuthoritySchema.refine((value) => value.preparation !== undefined),
  })
  .strict()
export const preparationExecutionContextSchema = z.discriminatedUnion("environment", [
  disposableExecutionContextSchema,
  productionExecutionContextSchema,
])
export type PreparationExecutionContext = z.infer<typeof preparationExecutionContextSchema>
export type TrustedPreparationHostPolicy = z.infer<typeof trustedPreparationHostPolicySchema>
const preparationStagingRecordBase = z
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
export const preparationStagingRecordSchema = z.discriminatedUnion("schema", [
  preparationStagingRecordBase,
  preparationStagingRecordBase.extend({
    schema: z.literal("lyrashield-preparation-staging/2"),
    purpose: z.literal("production-preparation"),
    executionContext: productionExecutionContextSchema,
  }),
])
export type PreparationStagingRecord = z.infer<typeof preparationStagingRecordSchema>

export function requirePreparationExecutionContext(
  input: unknown,
  policy: TrustedPreparationHostPolicy
): PreparationExecutionContext {
  const context = preparationExecutionContextSchema.parse(input)
  if (policy.schema === "lyrashield-preparation-host-policy/1") {
    if (
      context.environment !== "DISPOSABLE" ||
      canonicalJson(context) !== canonicalJson(policy.executionContext)
    )
      preparationProofFailure()
    return context
  }
  if (context.environment !== "PRODUCTION") preparationProofFailure()
  const delegation = requireCurrentPreparationDelegation(
    context.installed.preparation,
    context.installed
  )
  if (
    delegation.preparationPolicyChecksum !== sha256Hex(canonicalJson(policy)) ||
    delegation.issuerKeyHash !== policy.issuerKeyHash ||
    delegation.issuerKeyId !== policy.issuerKeyId ||
    context.installed.epochId !== policy.authorityEpochId ||
    context.installed.sourceRevision !== policy.productRevision
  )
    preparationProofFailure()
  return context
}

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
  const currentContext = requirePreparationExecutionContext(observedContext, policy)
  if (canonicalJson(currentContext) !== canonicalJson(record.executionContext))
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
  if (currentContext.environment === "PRODUCTION") {
    const delegation = currentContext.installed.preparation!
    if (
      record.schema !== "lyrashield-preparation-staging/2" ||
      Date.parse(record.expiresAt) > Date.parse(delegation.expiresAt) ||
      Date.parse(record.expiresAt) - Date.parse(record.issuedAt) >
        delegation.maxStagingLifetimeMs ||
      !delegation.targetTypes.includes(authority.target.type as "REPO") ||
      !delegation.scanWorkflows.includes(
        authority.executionPlan.workflow as "REVIEW_TARGET" | "REVIEW_CHANGES"
      )
    )
      preparationProofFailure()
  } else if (record.schema !== "lyrashield-preparation-staging/1") preparationProofFailure()
  return { record, recordChecksum: sha256Hex(envelope.raw) }
}

/** Inputs are supplied by the protected observer inside the locked compiler callback. */
export function buildPreparationStagingRecord(
  authority: ScanPreparationCommandAuthority,
  policy: TrustedPreparationHostPolicy,
  resources: PreparationStagingRecord["resources"],
  observed: PreparationStagingRecord["observed"],
  executionContext: PreparationExecutionContext
): PreparationStagingRecord {
  const context = requirePreparationExecutionContext(executionContext, policy)
  const production = context.environment === "PRODUCTION"
  if (
    production &&
    (!context.installed.preparation!.targetTypes.includes(authority.target.type as "REPO") ||
      !context.installed.preparation!.scanWorkflows.includes(
        authority.executionPlan.workflow as "REVIEW_TARGET" | "REVIEW_CHANGES"
      ) ||
      resources.source?.revision !== authority.executionPlan.source?.revision)
  )
    preparationProofFailure()
  const expiresAt = production
    ? new Date(
        Math.min(
          Date.parse(authority.attempt.expiresAt),
          Date.now() + context.installed.preparation!.maxStagingLifetimeMs,
          Date.parse(context.installed.preparation!.expiresAt)
        )
      ).toISOString()
    : authority.attempt.expiresAt
  if (Date.parse(expiresAt) <= Date.now()) preparationProofFailure()
  return preparationStagingRecordSchema.parse({
    schema: production ? "lyrashield-preparation-staging/2" : "lyrashield-preparation-staging/1",
    purpose: production ? "production-preparation" : "disposable-preparation",
    executionContext,
    issuerKeyHash: policy.issuerKeyHash,
    issuedAt: new Date().toISOString(),
    expiresAt,
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
