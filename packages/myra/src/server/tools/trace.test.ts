import "../test-env"
import { describe, expect, it, vi } from "vitest"
import { runAttachTrace } from "./trace"
import type { MyraToolContext } from "./types"

const principal = { kind: "user" as const, accountId: "trace-owner", sessionId: "trace-session" }

function setup(claimed: number) {
  const payload = {
    subject: "Scanner setup help",
    summary: "Scanner cannot connect to the repository.",
    includeDiagnostics: false,
    includeTranscriptExcerpt: false,
    replyEmail: "owner@example.test",
  }
  const db = {
    myraMessage: { findFirst: vi.fn().mockResolvedValue({ id: "message-1" }) },
    myraOperation: {
      findFirst: vi.fn().mockResolvedValue({
        id: "old-proposal",
        status: "AWAITING_CONFIRMATION",
        operationName: "submit_support_case",
        payload,
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: claimed }),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "new-proposal",
        operationName: data.operationName,
        status: "AWAITING_CONFIRMATION",
        payload: data.payload,
        expiresAt: data.expiresAt,
      })),
    },
  }
  const ctx: MyraToolContext = {
    principal,
    surface: "DASHBOARD",
    conversationId: "conversation-1",
    workspaceId: null,
    role: null,
    db: db as never,
  }
  return { db, ctx }
}

describe("attach_trace confirmation safety", () => {
  it("replaces an awaiting preview with a new proposal containing the trace", async () => {
    const { db, ctx } = setup(1)
    const result = await runAttachTrace(ctx, { traceId: "trace-1234" })
    expect(db.myraOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "old-proposal", status: "AWAITING_CONFIRMATION" },
      data: { status: "CANCELED" },
    })
    expect(result.data).toMatchObject({ attached: true, proposalId: "new-proposal" })
    expect(result.proposals?.[0]?.id).toBe("new-proposal")
    expect(result.components?.some((component) => component.type === "support_case_preview")).toBe(
      true
    )
    expect(db.myraOperation.create.mock.calls[0]?.[0].data.payload.traceId).toBe("trace-1234")
  })

  it("does not change or replace a proposal when the state claim loses", async () => {
    const { db, ctx } = setup(0)
    const result = await runAttachTrace(ctx, { traceId: "trace-1234" })
    expect(result.data).toMatchObject({ attached: false, proposalId: null })
    expect(db.myraOperation.create).not.toHaveBeenCalled()
    expect(db.myraOperation.update).not.toHaveBeenCalled()
  })
})
