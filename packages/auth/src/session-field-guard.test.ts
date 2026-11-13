import { beforeEach, describe, expect, it, vi } from "vitest"

const scopedConnFind = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspaceMember: { findUnique: vi.fn() },
    agentConnection: { findFirst: vi.fn() },
  },
  withWorkspaceRLS: vi.fn(async (_workspaceId, fn) =>
    fn({ agentConnection: { findFirst: scopedConnFind } })
  ),
}))

import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { validateSessionFieldWrite } from "./session-field-guard"

const memberFind = prisma.workspaceMember.findUnique as ReturnType<typeof vi.fn>
const connFind = scopedConnFind

describe("validateSessionFieldWrite — VERIFY-A-002 update-session boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    memberFind.mockResolvedValue({ status: "active" })
    connFind.mockResolvedValue({ id: "conn-1" })
  })

  it("allows activeWorkspaceId the user is an active member of", async () => {
    await expect(
      validateSessionFieldWrite({ activeWorkspaceId: "ws-1" }, "user-1")
    ).resolves.toBeUndefined()
    expect(memberFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_userId: { workspaceId: "ws-1", userId: "user-1" } },
      })
    )
  })

  it.each([[null], [{ status: "removed" }], [{ status: "suspended" }]])(
    "rejects activeWorkspaceId without active membership (%j)",
    async (member) => {
      memberFind.mockResolvedValue(member)
      await expect(
        validateSessionFieldWrite({ activeWorkspaceId: "ws-other" }, "user-1")
      ).rejects.toMatchObject({
        status: "FORBIDDEN",
        body: expect.objectContaining({ code: "WORKSPACE_SELECTION_FORBIDDEN" }),
      })
    }
  )

  it("rejects pendingAgentConnectionId the user does not own or is not ACTIVE", async () => {
    connFind.mockResolvedValue(null)
    await expect(
      validateSessionFieldWrite({ pendingAgentConnectionId: "conn-other" }, "user-1", "ws-1")
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: expect.objectContaining({ code: "CONNECTION_BINDING_FORBIDDEN" }),
    })
    expect(connFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn-other", workspaceId: "ws-1", userId: "user-1", status: "ACTIVE" },
      })
    )
  })

  it("allows an owned ACTIVE pendingAgentConnectionId", async () => {
    await expect(
      validateSessionFieldWrite({ pendingAgentConnectionId: "conn-1" }, "user-1", "ws-1")
    ).resolves.toBeUndefined()
  })

  it("uses the selected workspace transaction for the newly created connection", async () => {
    connFind.mockImplementation(async ({ where }) =>
      where.workspaceId === "ws-1" ? { id: "conn-1" } : null
    )
    await expect(
      validateSessionFieldWrite(
        { activeWorkspaceId: "ws-1", pendingAgentConnectionId: "conn-1" },
        "user-1",
        "ws-old"
      )
    ).resolves.toBeUndefined()
    expect(withWorkspaceRLS).toHaveBeenCalledWith("ws-1", expect.any(Function))
    expect(prisma.agentConnection.findFirst).not.toHaveBeenCalled()
  })

  it("rejects a connection outside the selected workspace", async () => {
    connFind.mockImplementation(async ({ where }) =>
      where.workspaceId === "ws-1" ? { id: "conn-1" } : null
    )
    await expect(
      validateSessionFieldWrite(
        { activeWorkspaceId: "ws-other", pendingAgentConnectionId: "conn-1" },
        "user-1"
      )
    ).rejects.toMatchObject({ body: { code: "CONNECTION_BINDING_FORBIDDEN" } })
  })

  it("rejects a pending connection without a workspace context", async () => {
    await expect(
      validateSessionFieldWrite({ pendingAgentConnectionId: "conn-1" }, "user-1")
    ).rejects.toMatchObject({ body: { code: "CONNECTION_BINDING_FORBIDDEN" } })
    expect(withWorkspaceRLS).not.toHaveBeenCalled()
  })

  it("requires active membership for the trusted session workspace fallback", async () => {
    memberFind.mockResolvedValue({ status: "removed" })
    await expect(
      validateSessionFieldWrite({ pendingAgentConnectionId: "conn-1" }, "user-1", "ws-1")
    ).rejects.toMatchObject({ body: { code: "WORKSPACE_SELECTION_FORBIDDEN" } })
    expect(connFind).not.toHaveBeenCalled()
  })

  it("ignores unrelated fields and non-string values", async () => {
    await expect(
      validateSessionFieldWrite({ name: "x", activeWorkspaceId: 42 }, "user-1")
    ).resolves.toBeUndefined()
    expect(memberFind).not.toHaveBeenCalled()
    expect(connFind).not.toHaveBeenCalled()
  })

  it("no-ops on non-object bodies", async () => {
    for (const body of [null, undefined, "str", 42, []]) {
      await expect(validateSessionFieldWrite(body, "user-1")).resolves.toBeUndefined()
    }
    expect(memberFind).not.toHaveBeenCalled()
  })

  it("validates both fields when both are present", async () => {
    memberFind.mockResolvedValue(null)
    await expect(
      validateSessionFieldWrite(
        { activeWorkspaceId: "ws-x", pendingAgentConnectionId: "conn-1" },
        "user-1"
      )
    ).rejects.toMatchObject({ status: "FORBIDDEN" })
    // Fails closed on the first bad field — the connection write never runs.
    expect(connFind).not.toHaveBeenCalled()
  })
})
