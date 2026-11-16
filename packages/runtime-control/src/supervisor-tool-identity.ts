import { hkdfSync } from "node:crypto"
import { z } from "zod"
import { canonicalJson, sha256Hex } from "./canonical-json"

const ownerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,121}$/)
const identitySchema = z
  .object({
    streamId: ownerId,
    authorityEpochId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/),
    supervisorInstanceId: ownerId,
    originalSigningSecret: z.string().min(32).max(4096),
    wrapperSigningSecret: z.string().min(32).max(4096),
  })
  .strict()

/** Private derived keys keep the tool namespace separate from controller receipts. */
export function deriveSupervisorToolJournalIdentity(input: z.infer<typeof identitySchema>) {
  const identity = identitySchema.parse(input)
  if (identity.originalSigningSecret === identity.wrapperSigningSecret)
    throw new Error("Protected tool journal identity is unavailable")
  const salt = canonicalJson({
    authorityEpochId: identity.authorityEpochId,
    supervisorInstanceId: identity.supervisorInstanceId,
  })
  const key = (secret: string, domain: string) =>
    Buffer.from(hkdfSync("sha256", secret, salt, domain, 32)).toString("hex")
  const originalSigningSecret = key(
    identity.originalSigningSecret,
    "lyrashield-supervisor-tool-original-key/1"
  )
  const wrapperSigningSecret = key(
    identity.wrapperSigningSecret,
    "lyrashield-supervisor-tool-wrapper-key/1"
  )
  return Object.freeze({
    streamId: `${identity.streamId}.tools`,
    authorityEpochId: identity.authorityEpochId,
    supervisorInstanceId: `${identity.supervisorInstanceId}.tools`,
    ownerSupervisorInstanceId: identity.supervisorInstanceId,
    originalSigningSecret,
    originalKeyHash: sha256Hex(originalSigningSecret),
    wrapperSigningSecret,
    wrapperKeyHash: sha256Hex(wrapperSigningSecret),
    responseSecret: key(
      identity.originalSigningSecret,
      "lyrashield-supervisor-tool-response-key/1"
    ),
  })
}
