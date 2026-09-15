/**
 * Anonymous public sessions. The bearer token is 32 random bytes base64url;
 * only its SHA-256 hash is stored. Expiry is 30 days, sliding on each
 * verified touch. The header is `x-myra-session`.
 */
import { createHash, randomBytes } from "node:crypto"
import { prisma } from "@lyrashield/db"
import type { MyraSurface } from "../contracts"
import { MYRA_LIMITS } from "../contracts"
import type { MyraDb } from "./db"

export const PUBLIC_SESSION_HEADER = "x-myra-session"

const SESSION_TTL_MS = MYRA_LIMITS.publicSessionTtlDays * 24 * 60 * 60 * 1000

export function hashPublicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function readPublicToken(request: Request): string | null {
  const token = request.headers.get(PUBLIC_SESSION_HEADER)?.trim()
  return token && token.length <= 256 ? token : null
}

export async function issuePublicSession(
  surface: MyraSurface,
  db: MyraDb = prisma
): Promise<{ token: string; publicSessionId: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const row = await db.myraPublicSession.create({
    data: { tokenHash: hashPublicToken(token), surface, expiresAt },
    select: { id: true },
  })
  return { token, publicSessionId: row.id, expiresAt }
}

/**
 * Verify a public token; on success returns the session id and slides the
 * expiry forward. Invalid/expired tokens return null.
 */
export async function verifyPublicToken(
  token: string,
  db: MyraDb = prisma
): Promise<string | null> {
  const tokenHash = hashPublicToken(token)
  const now = new Date()
  const row = await db.myraPublicSession.findUnique({
    where: { tokenHash },
    select: { id: true, expiresAt: true, lastSeenAt: true },
  })
  if (!row || row.expiresAt <= now) return null
  // Slide the expiry at most once an hour — the session stays valid either
  // way; per-request UPDATEs are pure churn on the verify hot path.
  const stale =
    !row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 60 * 60 * 1000
  if (stale) {
    await db.myraPublicSession.update({
      where: { id: row.id },
      data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
    })
  }
  return row.id
}
