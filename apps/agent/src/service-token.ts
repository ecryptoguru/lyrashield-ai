import { createHmac, timingSafeEqual } from "node:crypto"
import type { ServiceTokenPayload } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"

const TOKEN_TTL_SECONDS = 5 * 60

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set and at least 32 characters for service token signing"
    )
  }
  return secret
}

function base64UrlEncode(data: Buffer): string {
  return data.toString("base64url")
}

function base64UrlDecode(data: string): Buffer {
  return Buffer.from(data, "base64url")
}

export function signServiceToken(
  payload: Omit<ServiceTokenPayload, "issuedAt" | "expiresAt">
): string {
  const secret = getSecret()
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS

  const fullPayload: ServiceTokenPayload = {
    ...payload,
    issuedAt,
    expiresAt,
  }

  const payloadEncoded = base64UrlEncode(Buffer.from(JSON.stringify(fullPayload), "utf8"))
  const signature = createHmac("sha256", secret).update(payloadEncoded).digest()
  const signatureEncoded = base64UrlEncode(signature)

  return `lst.${payloadEncoded}.${signatureEncoded}`
}

export function verifyServiceToken(token: string): ServiceTokenPayload | null {
  if (!token.startsWith("lst.")) {
    return null
  }

  const parts = token.slice(4).split(".")
  if (parts.length !== 2) {
    return null
  }

  const [payloadEncoded, signatureEncoded] = parts as [string, string]
  const secret = getSecret()

  const expectedSignature = createHmac("sha256", secret).update(payloadEncoded).digest()
  const providedSignature = base64UrlDecode(signatureEncoded)

  if (expectedSignature.length !== providedSignature.length) {
    return null
  }

  if (!timingSafeEqual(expectedSignature, providedSignature)) {
    logger.warn("Service token signature mismatch")
    return null
  }

  let payload: ServiceTokenPayload
  try {
    payload = JSON.parse(base64UrlDecode(payloadEncoded).toString("utf8"))
  } catch {
    return null
  }

  if (
    typeof payload.userId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number"
  ) {
    logger.warn("Service token payload has missing or invalid fields")
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (payload.expiresAt < now) {
    logger.warn("Service token expired", { expiresAt: payload.expiresAt, now })
    return null
  }

  return payload
}
