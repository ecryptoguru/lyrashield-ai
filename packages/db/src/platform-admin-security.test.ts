import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { getSystemPrisma } = vi.hoisted(() => ({ getSystemPrisma: vi.fn() }))

vi.mock("./system-client", () => ({ getSystemPrisma }))

import {
  consumePlatformAdminChallengeAttempt,
  executePlatformAdminMutation,
  issuePlatformAdminElevation,
} from "./platform-admin-security"

type Elevation = {
  userId: string
  sessionId: string
  action: string
  nonceHash: string
  expiresAt: Date
  consumedAt: Date | null
}

describe("platform admin critical-action authorization", () => {
  let elevation: Elevation | undefined
  let userState: Record<string, unknown>
  let sessionState: Record<string, unknown> | null
  const auditCreate = vi.fn()
  const mutation = vi.fn(async () => "changed")

  beforeEach(() => {
    elevation = undefined
    userState = {}
    sessionState = {}
    auditCreate.mockReset()
    mutation.mockClear()

    const tx = {
      user: {
        findUnique: vi.fn(async () => ({
          email: "ankit@lyrashieldai.com",
          emailVerified: true,
          platformRole: "PLATFORM_OPERATOR",
          twoFactorEnabled: true,
          ...userState,
        })),
      },
      session: {
        findUnique: vi.fn(async () =>
          sessionState === null
            ? null
            : {
                userId: "user-1",
                expiresAt: new Date(Date.now() + 60_000),
                twoFactorVerifiedAt: new Date(Date.now() - 1_000),
                ...sessionState,
              }
        ),
      },
      platformAdminElevation: {
        updateMany: vi.fn(async ({ where, data }) => {
          if (
            !elevation ||
            elevation.consumedAt ||
            elevation.userId !== where.userId ||
            elevation.sessionId !== where.sessionId ||
            elevation.action !== where.action ||
            elevation.nonceHash !== where.nonceHash ||
            elevation.expiresAt <= where.expiresAt.gt
          ) {
            return { count: 0 }
          }
          elevation.consumedAt = data.consumedAt
          return { count: 1 }
        }),
      },
      platformAdminAudit: { create: auditCreate },
    }
    getSystemPrisma.mockReturnValue({
      platformAdminElevation: {
        create: vi.fn(async ({ data }) => {
          elevation = { ...data, consumedAt: null }
          return { id: "elevation-1", expiresAt: data.expiresAt }
        }),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
    })
  })

  it("stores only a nonce hash and consumes it once with a mandatory audit", async () => {
    const issued = await issuePlatformAdminElevation({
      userId: "user-1",
      sessionId: "session-1",
      action: "billing.refund",
      ttlMs: 60_000,
    })

    expect(issued.nonce).toHaveLength(43)
    expect(elevation?.nonceHash).toBe(
      createHash("sha256").update(issued.nonce, "utf8").digest("hex")
    )
    expect(JSON.stringify(elevation)).not.toContain(issued.nonce)

    await expect(
      executePlatformAdminMutation(
        {
          userId: "user-1",
          sessionId: "session-1",
          action: "billing.refund",
          nonce: issued.nonce,
          resourceType: "BillingAccount",
          resourceId: "billing-1",
        },
        mutation
      )
    ).resolves.toBe("changed")
    expect(auditCreate).toHaveBeenCalledOnce()

    await expect(
      executePlatformAdminMutation(
        {
          userId: "user-1",
          sessionId: "session-1",
          action: "billing.refund",
          nonce: issued.nonce,
          resourceType: "BillingAccount",
        },
        mutation
      )
    ).rejects.toThrow("ADMIN_ELEVATION_INVALID")
    expect(mutation).toHaveBeenCalledOnce()
  })

  it.each([
    ["wrong user", { userId: "user-2" }],
    ["wrong session", { sessionId: "session-2" }],
    ["wrong action", { action: "user.disable" }],
    ["wrong nonce", { nonce: "A".repeat(43) }],
  ])("rejects %s before mutation", async (_name, override) => {
    const issued = await issuePlatformAdminElevation({
      userId: "user-1",
      sessionId: "session-1",
      action: "billing.refund",
      ttlMs: 60_000,
    })

    await expect(
      executePlatformAdminMutation(
        {
          userId: "user-1",
          sessionId: "session-1",
          action: "billing.refund",
          nonce: issued.nonce,
          resourceType: "BillingAccount",
          ...override,
        },
        mutation
      )
    ).rejects.toThrow(
      override.userId === "user-2" ? "ADMIN_AUTHORITY_REVOKED" : "ADMIN_ELEVATION_INVALID"
    )
    expect(mutation).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("rejects expired authorization before mutation", async () => {
    const issued = await issuePlatformAdminElevation({
      userId: "user-1",
      sessionId: "session-1",
      action: "billing.refund",
      ttlMs: 60_000,
    })
    elevation!.expiresAt = new Date(Date.now() - 1)

    await expect(
      executePlatformAdminMutation(
        {
          userId: "user-1",
          sessionId: "session-1",
          action: "billing.refund",
          nonce: issued.nonce,
          resourceType: "BillingAccount",
        },
        mutation
      )
    ).rejects.toThrow("ADMIN_ELEVATION_INVALID")
    expect(mutation).not.toHaveBeenCalled()
  })

  it("rolls back the sensitive mutation when mandatory audit creation fails", async () => {
    const issued = await issuePlatformAdminElevation({
      userId: "user-1",
      sessionId: "session-1",
      action: "billing.refund",
      ttlMs: 60_000,
    })
    auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    await expect(
      executePlatformAdminMutation(
        {
          userId: "user-1",
          sessionId: "session-1",
          action: "billing.refund",
          nonce: issued.nonce,
          resourceType: "BillingAccount",
        },
        mutation
      )
    ).rejects.toThrow("audit unavailable")
  })

  it.each([
    ["demotion", { platformRole: null }, {}],
    ["email change", { email: "attacker@example.com" }, {}],
    ["MFA disable", { twoFactorEnabled: false }, {}],
    ["session deletion", {}, null],
    ["session expiry", {}, { expiresAt: new Date(Date.now() - 1) }],
  ])("rechecks %s inside the nonce-consumption transaction", async (_label, user, session) => {
    const issued = await issuePlatformAdminElevation({
      userId: "user-1",
      sessionId: "session-1",
      action: "billing.refund",
    })
    userState = user
    sessionState = session

    await expect(
      executePlatformAdminMutation(
        {
          userId: "user-1",
          sessionId: "session-1",
          action: "billing.refund",
          nonce: issued.nonce,
          resourceType: "BillingAccount",
        },
        mutation
      )
    ).rejects.toThrow("ADMIN_AUTHORITY_REVOKED")
    expect(mutation).not.toHaveBeenCalled()
  })
})

describe("platform admin challenge rate limit", () => {
  it("durably limits both the user and source IP before TOTP verification", async () => {
    const rows = new Map<
      string,
      { id: string; scope: string; keyHash: string; attemptCount: number; windowStartedAt: Date }
    >()
    const tx = {
      $executeRaw: vi.fn(),
      platformAdminChallengeLimit: {
        findMany: vi.fn(async ({ where }) =>
          where.OR.flatMap((key) => {
            const row = rows.get(`${key.scope}:${key.keyHash}`)
            return row ? [row] : []
          })
        ),
        create: vi.fn(async ({ data }) => {
          const row = { id: `limit-${rows.size + 1}`, ...data }
          rows.set(`${data.scope}:${data.keyHash}`, row)
          return row
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = [...rows.values()].find((value) => value.id === where.id)!
          row.attemptCount =
            typeof data.attemptCount === "number"
              ? data.attemptCount
              : row.attemptCount + data.attemptCount.increment
          if (data.windowStartedAt) row.windowStartedAt = data.windowStartedAt
          return row
        }),
      },
    }
    getSystemPrisma.mockReturnValue({
      $transaction: vi.fn(async (callback) => callback(tx)),
    })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        consumePlatformAdminChallengeAttempt({ userId: "user-1", ipAddress: "203.0.113.10" })
      ).resolves.toBeUndefined()
    }
    await expect(
      consumePlatformAdminChallengeAttempt({ userId: "user-1", ipAddress: "203.0.113.10" })
    ).rejects.toThrow("ADMIN_CHALLENGE_RATE_LIMITED")
    await expect(
      consumePlatformAdminChallengeAttempt({ userId: "user-2", ipAddress: "203.0.113.10" })
    ).rejects.toThrow("ADMIN_CHALLENGE_RATE_LIMITED")
    expect(tx.$executeRaw).toHaveBeenCalledTimes(14)
  })
})
