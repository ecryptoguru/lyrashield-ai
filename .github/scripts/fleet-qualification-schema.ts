import { createRequire } from "node:module"
import type * as Zod from "zod"

// Use the existing web package's declared Zod dependency, not an undeclared
// root dependency. This matches other scripts' workspace dependency ownership.
const { z } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
  "zod"
) as typeof Zod

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const revision = z.string().regex(/^[a-f0-9]{40}$/)
const id = z.string().regex(/^[1-9][0-9]{0,19}$/)
const seconds = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const owner = z.string().regex(/^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}$/)
export const fleetSchema = z
  .object({
    productRevision: revision,
    engineRevision: revision,
    webDigest: digest,
    scannerDigest: digest,
    proxyDigest: digest,
    workerDigest: digest,
    sandboxDigest: digest,
    brokerDigest: digest,
    supervisorDigest: digest,
    providerGatewayDigest: digest,
    migrationChecksum: digest,
    runtimePolicyDigest: digest,
  })
  .strict()
export const keyPinSchema = z
  .object({
    keyId: z.string().min(1).max(512),
    publicKey: z
      .object({
        kty: z.literal("RSA"),
        n: z
          .string()
          .min(1)
          .max(1024)
          .regex(/^[\w-]+$/),
        e: z.literal("AQAB"),
      })
      .strict(),
  })
  .strict()
export const managedKeySchema = keyPinSchema
  .extend({
    algorithm: z.literal("RS256"),
    clientId: z.string().uuid(),
    tenantId: z.string().uuid(),
  })
  .strict()
export const signedEnvelopeSchema = z
  .object({
    raw: z.string().min(1).max(16384),
    algorithm: z.literal("RS256"),
    keyId: z.string().min(1).max(512),
    signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict()
export const signatureResultSchema = signedEnvelopeSchema.omit({ raw: true })
const publicationSchema = z
  .object({
    publicationRevision: revision,
    publishRunId: id,
    publishAttempt: id,
    sandboxDigest: digest,
  })
  .strict()
const sourceSchema = z
  .object({
    productRepositoryId: z.literal("1286618458"),
    engineRepositoryId: z.literal("1297157605"),
    repositoryOwnerId: z.literal("116722580"),
    productRevision: revision,
    engineRevision: revision,
    productTreeSha: revision,
    engineTreeSha: revision,
    productCiReceiptDigest: digest,
    engineCiReceiptDigest: digest,
    productWorkflow: z.literal(".github/workflows/ci.yml"),
    productRunId: id,
    productAttempt: id,
    engineWorkflow: z.literal(".github/workflows/ci.yml"),
    engineRunId: id,
    engineAttempt: id,
    publication: publicationSchema,
  })
  .strict()
const nativeInventorySchema = z
  .object({
    manifestDigest: digest,
    inventoryDigest: digest,
    coverageDigest: digest,
    extractorDigest: digest,
    packageCount: z.number().int().positive().max(10000),
    coveredCount: z.number().int().positive().max(10000),
    scope: z.literal("ALL_ENUMERATED_PACKAGES"),
  })
  .strict()
  .refine((v) => v.packageCount === v.coveredCount)
export const evidenceSchemas = {
  fleet: fleetSchema,
  source: sourceSchema,
  inventory: z
    .object({
      provenanceBundleDigest: digest,
      amd64: nativeInventorySchema,
      arm64: nativeInventorySchema,
    })
    .strict(),
  migration: z.object({ checksum: digest, schemaProofDigest: digest }).strict(),
  policy: z.object({ digest, policyProofDigest: digest }).strict(),
  journal: z
    .object({
      epoch: seconds,
      sequence: seconds,
      supervisorHeadDigest: digest,
      independentHeadDigest: digest,
      postgresHeadDigest: digest,
      confirmedOperationDigest: digest,
    })
    .strict()
    .refine(
      (v) =>
        v.supervisorHeadDigest === v.independentHeadDigest &&
        v.independentHeadDigest === v.postgresHeadDigest
    ),
  rollback: z
    .object({
      fleet: fleetSchema,
      archiveDigest: digest,
      admission: z.literal("held"),
      journalProofDigest: digest,
    })
    .strict(),
} as const
export type EvidenceKind = keyof typeof evidenceSchemas
export type EvidenceData<K extends EvidenceKind> = Zod.infer<(typeof evidenceSchemas)[K]>
export const evidenceKinds = Object.freeze(Object.keys(evidenceSchemas) as EvidenceKind[])
export const evidenceHeaderSchema = z
  .object({
    schema: z.literal("lyrashield-closed-fleet-evidence/1"),
    kind: z.enum(evidenceKinds as [EvidenceKind, ...EvidenceKind[]]),
    owner,
    epoch: seconds,
    bindingDigest: digest,
    issuedAt: seconds,
    expiresAt: seconds,
    data: z.unknown(),
  })
  .strict()
  .refine((v) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 900)
export const issuerIdentitySchema = z
  .object({
    source: revision,
    owner,
    runId: id,
    attempt: id,
    path: z.literal(".github/workflows/qualify-runtime-issuer.yml"),
    event: z.literal("workflow_dispatch"),
    repoId: z.literal("1286618458"),
    ownerId: z.literal("116722580"),
  })
  .strict()
  .refine((v) => v.owner === v.runId + ":" + v.attempt)
export const intentSchema = z
  .object({
    schema: z.literal("lyrashield-closed-fleet-intent/1"),
    owner,
    epoch: seconds,
    candidateDigest: digest,
    nonce: z.string().uuid(),
    status: z.literal("CLAIMED"),
    issuedAt: seconds,
    expiresAt: seconds,
  })
  .strict()
  .refine((v) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 900)
export const journalReadbackSchema = z
  .object({
    schema: z.literal("lyrashield-closed-journal-readback/1"),
    owner,
    epoch: seconds,
    candidateDigest: digest,
    bindingDigest: digest,
    nonce: z.string().uuid(),
    issuedAt: seconds,
    expiresAt: seconds,
    data: evidenceSchemas.journal,
  })
  .strict()
  .refine((v) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 900)
export const candidateSchema = z
  .object({
    schema: z.literal("lyrashield-closed-fleet-candidate/1"),
    kind: z.literal("closed-fleet-candidate"),
    productionQualification: z.literal(false),
    issuer: issuerIdentitySchema,
    fleet: fleetSchema,
    source: sourceSchema,
    inventory: evidenceSchemas.inventory,
    journal: evidenceSchemas.journal,
    rollback: evidenceSchemas.rollback,
    evidence: z
      .object({
        fleet: digest,
        source: digest,
        inventory: digest,
        migration: digest,
        policy: digest,
        journal: digest,
        rollback: digest,
      })
      .strict(),
    nonce: z.string().uuid(),
    issuedAt: seconds,
    expiresAt: seconds,
  })
  .strict()
  .refine((v) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 900)
export type FleetCandidate = Zod.infer<typeof candidateSchema>
export type SignedEnvelope = Zod.infer<typeof signedEnvelopeSchema>
export type KeyPin = Zod.infer<typeof keyPinSchema>
export type ManagedKey = Zod.infer<typeof managedKeySchema>
export type IssuerIdentity = Zod.infer<typeof issuerIdentitySchema>
export type IssuanceIntent = Zod.infer<typeof intentSchema>
export type JournalReadback = Zod.infer<typeof journalReadbackSchema>

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value)
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return (
      "{" +
      Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key]
          if (!Object.hasOwn(descriptor, "value"))
            throw new Error("Canonical data cannot contain getters")
          return JSON.stringify(key) + ":" + canonicalJson(descriptor.value)
        })
        .join(",") +
      "}"
    )
  }
  throw new Error("Unsupported canonical JSON value")
}
