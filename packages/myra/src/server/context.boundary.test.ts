import { readFile } from "node:fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.hoisted(() => vi.fn())
const getWorkspaceMembership = vi.hoisted(() => vi.fn())
const findFirstMembership = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/auth/server", () => ({
  auth: { api: { getSession } },
  getWorkspaceMembership,
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { workspaceMember: { findFirst: findFirstMembership } },
}))
vi.mock("./session", () => ({ readPublicToken: () => null, verifyPublicToken: vi.fn() }))

const { resolveMyraRequest } = await import("./context")

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({
    user: { id: "user-1", email: "member@example.test", emailVerified: true },
    session: { id: "session-1" },
  })
  getWorkspaceMembership.mockReset().mockResolvedValue(null)
  findFirstMembership.mockReset().mockResolvedValue(null)
})

describe("Myra request context boundary", () => {
  it("keeps the Next-only auth module out of the worker-loaded server barrel", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed adjacent source file
    const source = await readFile(new URL("./context.ts", import.meta.url), "utf8")

    expect(source).not.toContain(
      'import { auth, getWorkspaceMembership } from "@lyrashield/auth/server"'
    )
    expect(source).toContain('await import("@lyrashield/auth/server")')
  })
})

describe("Myra signed-in workspace resolution", () => {
  it("uses the dashboard's oldest active membership when no cookie exists", async () => {
    findFirstMembership.mockResolvedValue({ workspaceId: "workspace-1", role: "OWNER" })

    const resolved = await resolveMyraRequest(
      new Request("https://app.lyrashieldai.com/api/myra/message")
    )

    expect(resolved?.workspaceId).toBe("workspace-1")
    expect(resolved?.role).toBe("OWNER")
    expect(findFirstMembership).toHaveBeenCalledWith({
      where: { userId: "user-1", status: "active" },
      orderBy: { createdAt: "asc" },
      select: { workspaceId: true, role: true },
    })
  })

  it("accepts a cookie only after current membership verification", async () => {
    getWorkspaceMembership.mockResolvedValue({ role: "ADMIN" })

    const resolved = await resolveMyraRequest(
      new Request("https://app.lyrashieldai.com/api/myra/message", {
        headers: { cookie: "activeWorkspaceId=workspace-2" },
      })
    )

    expect(resolved?.workspaceId).toBe("workspace-2")
    expect(getWorkspaceMembership).toHaveBeenCalledWith("workspace-2", "user-1")
    expect(findFirstMembership).not.toHaveBeenCalled()
  })

  it("does not trust a stale cookie or invent a workspace", async () => {
    const resolved = await resolveMyraRequest(
      new Request("https://app.lyrashieldai.com/api/myra/message", {
        headers: { cookie: "activeWorkspaceId=foreign-workspace" },
      })
    )

    expect(getWorkspaceMembership).toHaveBeenCalledWith("foreign-workspace", "user-1")
    expect(resolved?.workspaceId).toBeNull()
    expect(resolved?.role).toBeNull()
  })
})
