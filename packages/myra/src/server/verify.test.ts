import "./test-env"
import { describe, expect, it, vi } from "vitest"
import { findVerifiedEmail } from "./verify"

interface VerificationRow {
  publicSessionId: string | null
  consumedAt: Date | null
}

/**
 * Fake that applies the consumedAt bound the way Postgres would — the row is
 * only returned when it satisfies the query predicate.
 */
function fakeDbWith(row: VerificationRow | null) {
  return {
    myraIdentityVerification: {
      findFirst: vi.fn(async (args: { where: { consumedAt?: { not?: null; gte?: Date } } }) => {
        if (!row || row.consumedAt === null) return null
        const consumedAt = args.where.consumedAt
        if (consumedAt && typeof consumedAt === "object" && consumedAt.gte) {
          if (row.consumedAt < consumedAt.gte) return null
        }
        return row
      }),
    },
  }
}

describe("findVerifiedEmail", () => {
  it("accepts a code consumed within the verification window", async () => {
    const consumedAt = new Date(Date.now() - 30 * 60_000)
    const db = fakeDbWith({ publicSessionId: null, consumedAt })
    await expect(findVerifiedEmail("a@b.com", "support_case", null, db as never)).resolves.toEqual({
      consumedAt,
    })
  })

  it("rejects a code consumed more than an hour ago", async () => {
    const db = fakeDbWith({
      publicSessionId: null,
      consumedAt: new Date(Date.now() - 2 * 60 * 60_000),
    })
    await expect(
      findVerifiedEmail("a@b.com", "support_case", null, db as never)
    ).resolves.toBeNull()
  })

  it("still rejects a session-bound code held by a different session", async () => {
    const db = fakeDbWith({ publicSessionId: "ps_other", consumedAt: new Date() })
    await expect(
      findVerifiedEmail("a@b.com", "support_case", "ps_mine", db as never)
    ).resolves.toBeNull()
  })
})
