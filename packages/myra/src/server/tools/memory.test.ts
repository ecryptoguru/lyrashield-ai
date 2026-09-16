import "../test-env"
import { describe, expect, it, vi } from "vitest"
import { runClearMemory } from "./memory"

describe("runClearMemory", () => {
  it("deletes only the authenticated account's memory", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 })
    const db = { myraMemory: { deleteMany } }

    const result = await runClearMemory(
      {
        principal: { kind: "user", accountId: "acct-1", sessionId: "session-1" },
        surface: "DASHBOARD",
        workspaceId: null,
        role: null,
        conversationId: null,
        routeContext: null,
        db: db as never,
      },
      {}
    )

    expect(deleteMany).toHaveBeenCalledWith({ where: { accountId: "acct-1" } })
    expect(result.data).toEqual({ cleared: 2 })
  })
})
