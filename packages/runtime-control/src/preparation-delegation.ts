import { createHash, createPublicKey } from "node:crypto"
import { z } from "zod"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const preparationDelegationSchema = z
  .object({
    schema: z.literal("lyrashield-preparation-delegation/1"),
    purpose: z.literal("scan-preparation"),
    issuerKeyId: z.string().url().max(512),
    issuerKeyHash: hash,
    publicKey: z
      .object({
        kty: z.literal("RSA"),
        n: z.string().regex(/^[A-Za-z0-9_-]{512}$/),
        e: z.literal("AQAB"),
      })
      .strict(),
    preparationPolicyChecksum: hash,
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    workflow: z.literal(".github/workflows/issue-runtime-qualification.yml"),
    authorityEpochId: z.string().min(3).max(192),
    epoch: z.number().int().positive().max(2147483647),
    targetTypes: z.tuple([z.literal("REPO")]),
    scanWorkflows: z.tuple([z.literal("REVIEW_TARGET"), z.literal("REVIEW_CHANGES")]),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    maxStagingLifetimeMs: z.literal(900000),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const key = createPublicKey({ key: value.publicKey, format: "jwk" })
      const fingerprint = createHash("sha256")
        .update(key.export({ format: "der", type: "spki" }))
        .digest("hex")
      if (
        key.asymmetricKeyDetails?.modulusLength !== 3072 ||
        key.asymmetricKeyDetails?.publicExponent !== 65537n ||
        fingerprint !== value.issuerKeyHash ||
        Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
        Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 86400000
      )
        context.addIssue({
          code: "custom",
          message: "Preparation delegation identity or lifetime is invalid",
        })
    } catch {
      context.addIssue({ code: "custom", message: "Preparation delegation key is invalid" })
    }
  })
export type PreparationDelegation = z.infer<typeof preparationDelegationSchema>

export function requireCurrentPreparationDelegation(
  input: unknown,
  authority: {
    sourceRevision: string
    epochId: string
    epoch: number
  },
  now = Date.now()
): PreparationDelegation {
  const delegation = preparationDelegationSchema.parse(input)
  if (
    delegation.productRevision !== authority.sourceRevision ||
    delegation.authorityEpochId !== authority.epochId ||
    delegation.epoch !== authority.epoch ||
    Date.parse(delegation.issuedAt) > now ||
    Date.parse(delegation.expiresAt) <= now
  )
    throw new Error("Qualified preparation delegation is unavailable")
  return delegation
}
