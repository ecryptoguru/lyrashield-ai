import "../test-env"
import { describe, expect, it, vi } from "vitest"
import { executeSubmitSupportCase, runProposeSupportCase } from "./cases"
import type { MyraToolContext } from "./types"

const userPrincipal = {
  kind: "user" as const,
  accountId: "acct-1",
  sessionId: "sess-1",
  workspaceId: null,
  role: null,
}

function ctxFor(db: unknown): MyraToolContext {
  return {
    principal: userPrincipal,
    surface: "DASHBOARD",
    conversationId: null,
    workspaceId: null,
    role: null,
    db: db as never,
  }
}

function fakeDb(opts: { accountEmail?: string | null; verifiedRow?: unknown } = {}) {
  return {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts.accountEmail === null ? null : { email: opts.accountEmail ?? "owner@example.com" }
        ),
    },
    myraIdentityVerification: {
      findFirst: vi.fn().mockResolvedValue(opts.verifiedRow ?? null),
    },
    myraOperation: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "op-1",
        operationName: "submit_support_case",
        status: "AWAITING_CONFIRMATION",
        expiresAt: new Date(Date.now() + 900_000),
        payload: {},
        inputHash: "hash",
        idempotencyKey: "key",
        result: null,
      }),
    },
  }
}

const baseInput = {
  subject: "Need help with setup",
  summary: "Cannot connect the scanner to our repository.",
}

describe("reply destination verification", () => {
  it("rejects a foreign unverified replyEmail for a signed-in user", async () => {
    const db = fakeDb()
    await expect(
      runProposeSupportCase(ctxFor(db), { ...baseInput, replyEmail: "foreign@example.com" })
    ).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED" })
    expect(db.myraOperation.create).not.toHaveBeenCalled()
  })

  it("rejects a foreign unverified replyEmail again at execution time", async () => {
    const db = fakeDb()
    await expect(
      executeSubmitSupportCase(
        { ...baseInput, replyEmail: "foreign@example.com" },
        { principal: userPrincipal, conversationId: null, db: db as never }
      )
    ).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED" })
  })

  it("accepts the account email as the reply destination", async () => {
    const db = fakeDb()
    const result = await runProposeSupportCase(ctxFor(db), {
      ...baseInput,
      replyEmail: "owner@example.com",
    })
    expect(result.proposals?.[0]?.id).toBe("op-1")
    expect(db.myraIdentityVerification.findFirst).not.toHaveBeenCalled()
  })

  it("accepts a foreign replyEmail verified within the window", async () => {
    const db = fakeDb({ verifiedRow: { publicSessionId: null, consumedAt: new Date() } })
    const result = await runProposeSupportCase(ctxFor(db), {
      ...baseInput,
      replyEmail: "foreign@example.com",
    })
    expect(result.proposals?.[0]?.id).toBe("op-1")
  })

  it("falls back to the account email when no replyEmail is given", async () => {
    const db = fakeDb()
    const result = await runProposeSupportCase(ctxFor(db), baseInput)
    expect(result.proposals?.[0]?.id).toBe("op-1")
    const stored = db.myraOperation.create.mock.calls[0]?.[0] as {
      data: { payload: { replyEmail?: string } }
    }
    expect(stored.data.payload.replyEmail).toBe("owner@example.com")
  })
})
