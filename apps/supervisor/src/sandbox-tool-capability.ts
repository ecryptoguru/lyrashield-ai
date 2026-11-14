import { createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import { canonicalJson, resourceOwnershipSchema } from "@lyrashield/runtime-control"

const id = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
// The accepted REPO Deep/Custom execution plan and SQL authority cap runtime at 2,700,000ms.
const RETAINED_REPO_RUNTIME_MAX_MS = 2_700_000
export const sandboxToolCapabilitySchema = z
  .object({
    schema: z.literal("lyrashield-sandbox-tool-capability/1"),
    authorityEpochId: id,
    operationId: id,
    attemptId: id,
    scanId: id,
    workspaceId: id,
    authorityRevision: z.number().int().positive().safe(),
    prepareCommandId: id,
    prepareCommandInputChecksum: hash,
    authorityChecksum: hash,
    ownershipReceiptId: id,
    ownership: resourceOwnershipSchema,
    sandboxHandle: id,
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (scope) =>
      scope.ownership.kind === "container" &&
      scope.ownership.executorKey === "sandbox" &&
      /^[a-f0-9]{64}$/.test(scope.ownership.containerId ?? "") &&
      scope.sandboxHandle === scope.ownership.ownershipId
  )
export type SandboxToolCapability = z.infer<typeof sandboxToolCapabilitySchema>

function decode(value: string, maximum: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Sandbox capability is invalid")
  const bytes = Buffer.from(value, "base64url")
  if (bytes.byteLength > maximum || bytes.toString("base64url") !== value)
    throw new Error("Sandbox capability is invalid")
  return bytes
}

/** The public key is the delegated sandbox signer from the verified installed runtime authority. */
export function createSandboxToolCapabilityVerifier(options: {
  publicKeyPem: string
  keyId: string
  authorityEpochId: string
  now?: () => number
}) {
  if (
    typeof options.publicKeyPem !== "string" ||
    Buffer.byteLength(options.publicKeyPem) > 4096 ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(
      options.publicKeyPem
    )
  )
    throw new Error("Installed sandbox signer must be a bounded SPKI public key")
  const publicKey = createPublicKey({ key: options.publicKeyPem, format: "pem", type: "spki" })
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  )
    throw new Error("Installed sandbox signer is invalid")
  id.parse(options.authorityEpochId)
  id.parse(options.keyId)
  return (
    token: string,
    expected: { attemptId: string; sandboxHandle: string },
    purpose: "invoke" | "observe" = "invoke"
  ) => {
    if (typeof token !== "string" || token.length > 2048)
      throw new Error("Sandbox capability is invalid")
    const parts = token.split(".")
    if (parts.length !== 3) throw new Error("Sandbox capability is invalid")
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    const header = z
      .object({ alg: z.literal("RS256"), typ: z.literal("JWT"), kid: z.literal(options.keyId) })
      .strict()
      .parse(JSON.parse(decode(headerPart, 256).toString("utf8")))
    if (
      canonicalJson(header) !== decode(headerPart, 256).toString("utf8") ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${headerPart}.${payloadPart}`),
        publicKey,
        decode(signaturePart, 1024)
      )
    )
      throw new Error("Sandbox capability signature differs")
    const payload = decode(payloadPart, 1400).toString("utf8")
    const scope = sandboxToolCapabilitySchema.parse(JSON.parse(payload))
    const issued = Date.parse(scope.issuedAt),
      expires = Date.parse(scope.expiresAt),
      now = options.now?.() ?? Date.now()
    if (
      canonicalJson(scope) !== payload ||
      scope.authorityEpochId !== options.authorityEpochId ||
      scope.attemptId !== expected.attemptId ||
      scope.sandboxHandle !== expected.sandboxHandle ||
      expires <= issued ||
      expires - issued > RETAINED_REPO_RUNTIME_MAX_MS ||
      issued > now ||
      (purpose === "invoke" && expires <= now)
    )
      throw new Error("Sandbox capability scope differs")
    return Object.freeze(scope)
  }
}
