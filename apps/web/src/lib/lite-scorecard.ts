import { createHmac, timingSafeEqual } from "node:crypto"
import {
  buildLiteScorecardPayload,
  LITE_CHECK_VERSION,
  LITE_SCORECARD_PAYLOAD_VERSION,
  type LiteScorecardPayload,
} from "@lyrashield/security"

function signingSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32) throw new Error("Lite scorecard signing is not configured")
  return secret
}

function signature(encodedPayload: string): string {
  return createHmac("sha256", signingSecret())
    .update(`lyrashield-lite-scorecard-v1:${encodedPayload}`)
    .digest("base64url")
}

export function createLiteScorecardToken(payload: LiteScorecardPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encoded}.${signature(encoded)}`
}

export function parseLiteScorecardToken(token: string): LiteScorecardPayload | null {
  const [encoded, supplied, extra] = token.split(".")
  if (!encoded || !supplied || extra || token.length > 1024) return null
  const expected = signature(encoded)
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null
  }
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<LiteScorecardPayload>
    if (
      value.kind !== "lite-check" ||
      value.payloadVersion !== LITE_SCORECARD_PAYLOAD_VERSION ||
      value.checkVersion !== LITE_CHECK_VERSION
    ) {
      return null
    }
    return buildLiteScorecardPayload({
      needsAttention: value.needsAttention as number,
      worthReviewing: value.worthReviewing as number,
      looksOk: value.looksOk as number,
      referralCode: value.referralCode,
      generatedAt: value.generatedAt,
    })
  } catch {
    return null
  }
}
