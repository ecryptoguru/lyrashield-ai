/**
 * Bounded email identity verification for public support-case replies and
 * demo attendees. Six-digit codes, SHA-256 stored, 15-minute TTL, max 3
 * sends/hour/email, max 5 confirm attempts. Never reveals whether an address
 * already owns cases or bookings.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { sendNotification } from "@lyrashield/integrations"
import { MYRA_LIMITS } from "../contracts"
import { err } from "./errors"
import type { MyraDb } from "./db"

export type IdentityPurpose = "support_case" | "demo_booking"
export type IdentityBinding =
  { accountId: string; publicSessionId?: never } | { publicSessionId: string; accountId?: never }

const MAX_SENDS_PER_HOUR = 3

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

export async function requestIdentityCode(
  email: string,
  purpose: IdentityPurpose,
  binding: IdentityBinding,
  db: MyraDb = prisma
): Promise<{ sent: boolean; expiresAt: Date }> {
  const normalized = email.trim().toLowerCase()
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const recentSends = await db.myraIdentityVerification.count({
    where: { email: normalized, purpose, createdAt: { gte: hourAgo } },
  })
  if (recentSends >= MAX_SENDS_PER_HOUR) {
    throw err("RATE_LIMITED", "Too many verification emails. Try again later.")
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0")
  const expiresAt = new Date(Date.now() + MYRA_LIMITS.identityCodeTtlMinutes * 60 * 1000)

  // One active code per (email, purpose): supersede prior unconsumed codes.
  await db.myraIdentityVerification.deleteMany({
    where: {
      email: normalized,
      purpose,
      consumedAt: null,
      accountId: binding.accountId ?? null,
      publicSessionId: binding.publicSessionId ?? null,
    },
  })
  await db.myraIdentityVerification.create({
    data: {
      email: normalized,
      purpose,
      codeHash: hashCode(code),
      accountId: binding.accountId ?? null,
      publicSessionId: binding.publicSessionId ?? null,
      expiresAt,
    },
  })

  const sent = await sendNotification(
    "email",
    {
      type: "myra_identity_code",
      title: "Your LyraShield verification code",
      body: `Your verification code is ${code}. It expires in ${MYRA_LIMITS.identityCodeTtlMinutes} minutes. If you did not request it, ignore this email.`,
    },
    [normalized]
  )
  return { sent, expiresAt }
}

/**
 * Confirm a code. Consumes it on match; increments attempts either way.
 * Returns a bare boolean — never which check failed or whether the email is
 * known.
 */
export async function confirmIdentityCode(
  email: string,
  purpose: IdentityPurpose,
  code: string,
  binding: IdentityBinding,
  db: MyraDb = prisma
): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const row = await db.myraIdentityVerification.findFirst({
    where: {
      email: normalized,
      purpose,
      consumedAt: null,
      accountId: binding.accountId ?? null,
      publicSessionId: binding.publicSessionId ?? null,
    },
    orderBy: { createdAt: "desc" },
  })
  if (!row) return false
  if (row.attempts >= MYRA_LIMITS.identityCodeMaxAttempts || row.expiresAt <= new Date()) {
    return false
  }
  await db.myraIdentityVerification.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  })
  const candidate = hashCode(code.trim())
  const stored = row.codeHash
  const match =
    candidate.length === stored.length &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(stored))
  if (!match) return false
  await db.myraIdentityVerification.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  })
  return true
}

/**
 * The latest consumed verification for this principal, email and purpose, or
 * null. A consumed code counts only for four code lifetimes (one hour).
 */
export async function findVerifiedEmail(
  email: string,
  purpose: IdentityPurpose,
  binding: IdentityBinding,
  db: MyraDb = prisma
): Promise<{ consumedAt: Date | null } | null> {
  const normalized = email.trim().toLowerCase()
  const verifiedSince = new Date(Date.now() - MYRA_LIMITS.identityCodeTtlMinutes * 4 * 60 * 1000)
  const row = await db.myraIdentityVerification.findFirst({
    where: {
      email: normalized,
      purpose,
      accountId: binding.accountId ?? null,
      publicSessionId: binding.publicSessionId ?? null,
      consumedAt: { not: null, gte: verifiedSince },
    },
    orderBy: { consumedAt: "desc" },
    select: { consumedAt: true },
  })
  if (!row) return null
  return { consumedAt: row.consumedAt }
}

export async function hasVerifiedEmail(
  email: string,
  purpose: IdentityPurpose,
  binding: IdentityBinding,
  db: MyraDb = prisma
): Promise<boolean> {
  return (await findVerifiedEmail(email, purpose, binding, db)) !== null
}
