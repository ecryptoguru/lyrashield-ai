import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { env } from "@lyrashield/config"
import type { AuthSession } from "@lyrashield/auth/server"

const SYNC_SESSION_TTL_MS = 15 * 60 * 1000
const SIGNING_CONTEXT = "lyrashield-sync-session-v1"

const SyncSessionPayloadSchema = z.object({
  v: z.literal(1),
  workspaceId: z.string().min(1),
  licenseId: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  exp: z.number().int().positive(),
})

type SyncSessionPayload = z.infer<typeof SyncSessionPayloadSchema>

function sign(encodedPayload: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`${SIGNING_CONTEXT}.${encodedPayload}`)
    .digest("base64url")
}

export function createSyncSessionToken(
  input: {
    workspaceId: string
    licenseId: string
    session: Pick<AuthSession, "userId" | "sessionId">
  },
  now = Date.now()
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now + SYNC_SESSION_TTL_MS)
  const payload: SyncSessionPayload = {
    v: 1,
    workspaceId: input.workspaceId,
    licenseId: input.licenseId,
    userId: input.session.userId,
    sessionId: input.session.sessionId,
    exp: expiresAt.getTime(),
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return { token: `${encodedPayload}.${sign(encodedPayload)}`, expiresAt }
}

export type VerifySyncSessionResult =
  | { valid: true; licenseId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" | "identity_mismatch" }

export function verifySyncSessionToken(
  token: string,
  expected: {
    workspaceId: string
    session: Pick<AuthSession, "userId" | "sessionId">
  },
  now = Date.now()
): VerifySyncSessionResult {
  const parts = token.split(".")
  if (parts.length !== 2) return { valid: false, reason: "malformed" }
  const [encodedPayload, suppliedSignature] = parts as [string, string]
  if (!encodedPayload || !suppliedSignature) return { valid: false, reason: "malformed" }

  const expectedSignature = sign(encodedPayload)
  const supplied = Buffer.from(suppliedSignature)
  const signed = Buffer.from(expectedSignature)
  if (supplied.length !== signed.length || !timingSafeEqual(supplied, signed)) {
    return { valid: false, reason: "bad_signature" }
  }

  let rawPayload: unknown
  try {
    rawPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
  } catch {
    return { valid: false, reason: "malformed" }
  }
  const parsed = SyncSessionPayloadSchema.safeParse(rawPayload)
  if (!parsed.success) return { valid: false, reason: "malformed" }
  const payload = parsed.data
  if (now >= payload.exp) return { valid: false, reason: "expired" }
  if (
    payload.workspaceId !== expected.workspaceId ||
    payload.userId !== expected.session.userId ||
    payload.sessionId !== expected.session.sessionId
  ) {
    return { valid: false, reason: "identity_mismatch" }
  }
  return { valid: true, licenseId: payload.licenseId }
}
