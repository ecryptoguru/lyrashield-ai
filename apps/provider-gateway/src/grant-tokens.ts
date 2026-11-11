import { createHmac, timingSafeEqual } from "node:crypto"
import { sha256Hex, type ProviderGrantRequest } from "@lyrashield/runtime-control"
import { ProviderGatewayError } from "./errors"

const GRANT_TOKEN_VERSION = 1

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function grantIdFor(request: ProviderGrantRequest): string {
  return `pg_${sha256Hex(`${request.grantRequestId}\0${request.attemptId}\0${request.providerId}`).slice(0, 40)}`
}

function tokenPayload(request: ProviderGrantRequest, grantId: string) {
  return {
    v: GRANT_TOKEN_VERSION,
    grantId,
    attemptId: request.attemptId,
    providerId: request.providerId,
    expiresAt: request.expiresAt,
  }
}

export function signToken(
  signingSecret: string,
  request: ProviderGrantRequest,
  grantId: string
): string {
  const payload = Buffer.from(JSON.stringify(tokenPayload(request, grantId)), "utf8").toString(
    "base64url"
  )
  const signature = createHmac("sha256", signingSecret).update(payload, "utf8").digest("base64url")
  return `${payload}.${signature}`
}

export function verifyToken(
  signingSecret: string,
  token: string
): { grantId: string; attemptId: string; providerId: string } {
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
  if (parsed === null || typeof parsed !== "object")
    throw new ProviderGatewayError("INVALID_GRANT", "invalid provider grant")
  const record = parsed
  if (
    Reflect.get(record, "v") !== GRANT_TOKEN_VERSION ||
    typeof Reflect.get(record, "grantId") !== "string" ||
    typeof Reflect.get(record, "attemptId") !== "string" ||
    typeof Reflect.get(record, "providerId") !== "string"
  ) {
    throw new ProviderGatewayError("INVALID_GRANT", "invalid provider grant")
  }
  return {
    grantId: Reflect.get(record, "grantId"),
    attemptId: Reflect.get(record, "attemptId"),
    providerId: Reflect.get(record, "providerId"),
  }
}
