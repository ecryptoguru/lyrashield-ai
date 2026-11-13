import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { sha256Hex, type ProviderGrantRequest } from "@lyrashield/runtime-control"
import { ProviderGatewayError } from "./errors"

const GRANT_TOKEN_VERSION = 2
const tokenPayloadSchema = z
  .object({
    v: z.literal(GRANT_TOKEN_VERSION),
    grantId: z.string(),
    attemptId: z.string(),
    scanId: z.string(),
    workspaceId: z.string(),
    operationId: z.string(),
    authorityEpochId: z.string(),
    authorityRevision: z.number().int().nonnegative(),
    providerId: z.string(),
    expiresAt: z.string(),
    policyDigest: z.string().nullable(),
  })
  .strict()

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function grantIdFor(request: ProviderGrantRequest): string {
  return `pg_${sha256Hex(`${request.grantRequestId}\0${request.attemptId}\0${request.providerId}`).slice(0, 40)}`
}

function tokenPayload(request: ProviderGrantRequest, grantId: string, policyDigest: string | null) {
  return {
    v: GRANT_TOKEN_VERSION,
    grantId,
    attemptId: request.attemptId,
    scanId: request.scanId,
    workspaceId: request.workspaceId,
    operationId: request.operationId,
    authorityEpochId: request.authorityEpochId,
    authorityRevision: request.authorityRevision,
    providerId: request.providerId,
    expiresAt: request.expiresAt,
    policyDigest,
  }
}

export function signToken(
  signingSecret: string,
  request: ProviderGrantRequest,
  grantId: string,
  policyDigest: string | null = null
): string {
  const payload = Buffer.from(
    JSON.stringify(tokenPayload(request, grantId, policyDigest)),
    "utf8"
  ).toString("base64url")
  const signature = createHmac("sha256", signingSecret).update(payload, "utf8").digest("base64url")
  return `${payload}.${signature}`
}

export function verifyToken(
  signingSecret: string,
  token: string
): z.infer<typeof tokenPayloadSchema> {
  const [payload, signature, extra] = token.split(".")
  if (!payload || !signature || extra)
    throw new ProviderGatewayError("INVALID_GRANT", "invalid provider grant")
  const expected = createHmac("sha256", signingSecret).update(payload, "utf8").digest("base64url")
  if (!secureEqual(signature, expected))
    throw new ProviderGatewayError("INVALID_GRANT", "invalid provider grant")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    throw new ProviderGatewayError("INVALID_GRANT", "invalid provider grant")
  }
  const result = tokenPayloadSchema.safeParse(parsed)
  if (!result.success) {
    throw new ProviderGatewayError("INVALID_GRANT", "invalid provider grant")
  }
  return result.data
}
