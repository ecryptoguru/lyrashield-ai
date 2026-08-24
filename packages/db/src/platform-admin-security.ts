import { createHash, randomBytes } from "node:crypto"
import { Prisma } from "./generated/prisma"
import { getSystemPrisma } from "./system-client"
import { APPROVED_PLATFORM_ADMIN_EMAILS } from "@lyrashield/config"

const DEFAULT_ELEVATION_TTL_MS = 5 * 60 * 1000
const MAX_ELEVATION_TTL_MS = 10 * 60 * 1000
const ADMIN_ACTION = /^[a-z][a-z0-9_.:-]{2,127}$/
const NONCE = /^[A-Za-z0-9_-]{43}$/
const CHALLENGE_WINDOW_MS = 15 * 60 * 1000
const CHALLENGE_ATTEMPT_LIMIT = 5
const MAX_MUTATION_SESSION_AGE_MS = 30 * 60 * 1000

type AuditMetadata = Prisma.InputJsonValue

export interface IssuePlatformAdminElevationInput {
  userId: string
  sessionId: string
  action: string
  ttlMs?: number
}

export interface PlatformAdminMutationInput {
  userId: string
  sessionId: string
  action: string
  nonce: string
  resourceType: string
  resourceId?: string
  ipAddress?: string
  userAgent?: string
  metadata?: AuditMetadata
}

function assertIdentifier(value: string, field: string, maxLength = 191): void {
  if (!value || value.length > maxLength || value.trim() !== value) {
    throw new Error(`INVALID_${field.toUpperCase()}`)
  }
}

function assertAction(action: string): void {
  if (!ADMIN_ACTION.test(action)) throw new Error("INVALID_ADMIN_ACTION")
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex")
}

function challengeKey(scope: "USER" | "IP", value: string): string {
  return createHash("sha256").update(`${scope}:${value}`, "utf8").digest("hex")
}

/**
 * Must run before Better Auth's TOTP verifier. Counts every attempt so a
 * successful request cannot race a failed request and erase its penalty.
 */
export async function consumePlatformAdminChallengeAttempt(input: {
  userId: string
  ipAddress: string
}): Promise<void> {
  assertIdentifier(input.userId, "admin_user_id")
  assertIdentifier(input.ipAddress, "admin_ip_address", 64)
  const keys = [
    { scope: "USER", keyHash: challengeKey("USER", input.userId) },
    { scope: "IP", keyHash: challengeKey("IP", input.ipAddress) },
  ].sort((left, right) => left.keyHash.localeCompare(right.keyHash))
  const now = new Date()
  const activeSince = new Date(now.getTime() - CHALLENGE_WINDOW_MS)

  await getSystemPrisma().$transaction(async (tx) => {
    for (const key of keys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key.keyHash}, 0))`
    }
    const current = await tx.platformAdminChallengeLimit.findMany({
      where: { OR: keys },
    })
    const byKey = new Map(current.map((entry) => [`${entry.scope}:${entry.keyHash}`, entry]))
    for (const key of keys) {
      const existing = byKey.get(`${key.scope}:${key.keyHash}`)
      if (
        existing &&
        existing.windowStartedAt > activeSince &&
        existing.attemptCount >= CHALLENGE_ATTEMPT_LIMIT
      ) {
        throw new Error("ADMIN_CHALLENGE_RATE_LIMITED")
      }
    }
    for (const key of keys) {
      const existing = byKey.get(`${key.scope}:${key.keyHash}`)
      if (!existing) {
        await tx.platformAdminChallengeLimit.create({
          data: { ...key, attemptCount: 1, windowStartedAt: now },
        })
      } else if (existing.windowStartedAt <= activeSince) {
        await tx.platformAdminChallengeLimit.update({
          where: { id: existing.id },
          data: { attemptCount: 1, windowStartedAt: now },
        })
      } else {
        await tx.platformAdminChallengeLimit.update({
          where: { id: existing.id },
          data: { attemptCount: { increment: 1 } },
        })
      }
    }
  })
}

/**
 * Creates a short-lived, action-specific authorization after the API has
 * completed its explicit TOTP challenge. Only the nonce hash is persisted.
 */
export async function issuePlatformAdminElevation(
  input: IssuePlatformAdminElevationInput
): Promise<{
  nonce: string
  expiresAt: Date
}> {
  assertIdentifier(input.userId, "admin_user_id")
  assertIdentifier(input.sessionId, "admin_session_id")
  assertAction(input.action)
  const ttlMs = input.ttlMs ?? DEFAULT_ELEVATION_TTL_MS
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_ELEVATION_TTL_MS) {
    throw new Error("INVALID_ADMIN_ELEVATION_TTL")
  }

  const nonce = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + ttlMs)
  await getSystemPrisma().platformAdminElevation.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      action: input.action,
      nonceHash: hashNonce(nonce),
      expiresAt,
    },
  })
  return { nonce, expiresAt }
}

/**
 * Runs one database-only critical mutation and its platform audit in one
 * transaction. Audit failure rolls back the mutation and nonce consumption.
 */
export async function executePlatformAdminMutation<T>(
  input: PlatformAdminMutationInput,
  mutate: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  assertIdentifier(input.userId, "admin_user_id")
  assertIdentifier(input.sessionId, "admin_session_id")
  assertAction(input.action)
  if (!NONCE.test(input.nonce)) throw new Error("ADMIN_ELEVATION_INVALID")
  assertIdentifier(input.resourceType, "admin_resource_type", 100)
  if (input.resourceId !== undefined) assertIdentifier(input.resourceId, "admin_resource_id")
  if (input.ipAddress !== undefined) assertIdentifier(input.ipAddress, "admin_ip_address", 64)
  if (input.userAgent !== undefined) assertIdentifier(input.userAgent, "admin_user_agent", 512)

  return getSystemPrisma().$transaction(async (tx) => {
    const consumedAt = new Date()
    const [user, session] = await Promise.all([
      tx.user.findUnique({
        where: { id: input.userId },
        select: { email: true, emailVerified: true, platformRole: true, twoFactorEnabled: true },
      }),
      tx.session.findUnique({
        where: { id: input.sessionId },
        select: { userId: true, expiresAt: true, twoFactorVerifiedAt: true },
      }),
    ])
    const email = user?.email.trim().toLowerCase()
    const verifiedAt = session?.twoFactorVerifiedAt?.getTime()
    if (
      !user ||
      !email ||
      !APPROVED_PLATFORM_ADMIN_EMAILS.includes(
        email as (typeof APPROVED_PLATFORM_ADMIN_EMAILS)[number]
      ) ||
      !user.emailVerified ||
      user.platformRole !== "PLATFORM_OPERATOR" ||
      !user.twoFactorEnabled ||
      !session ||
      session.userId !== input.userId ||
      session.expiresAt <= consumedAt ||
      verifiedAt === undefined ||
      consumedAt.getTime() - verifiedAt < 0 ||
      consumedAt.getTime() - verifiedAt > MAX_MUTATION_SESSION_AGE_MS
    ) {
      throw new Error("ADMIN_AUTHORITY_REVOKED")
    }
    const consumed = await tx.platformAdminElevation.updateMany({
      where: {
        userId: input.userId,
        sessionId: input.sessionId,
        action: input.action,
        nonceHash: hashNonce(input.nonce),
        consumedAt: null,
        expiresAt: { gt: consumedAt },
      },
      data: { consumedAt },
    })
    if (consumed.count !== 1) throw new Error("ADMIN_ELEVATION_INVALID")

    const result = await mutate(tx as unknown as Prisma.TransactionClient)
    await tx.platformAdminAudit.create({
      data: {
        actorUserId: input.userId,
        sessionId: input.sessionId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: input.metadata,
      },
    })
    return result
  })
}
