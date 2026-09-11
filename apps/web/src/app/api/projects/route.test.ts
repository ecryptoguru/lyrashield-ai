import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    project: { create: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
  },
}))

const requireWorkspaceAccess = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(),
  requirePermission: vi.fn(),
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { project: { create: "project:create" } } }))
vi.mock("@lyrashield/types", () => ({ CreateProjectSchema: { safeParse: vi.fn() } }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}))

import { prisma } from "@lyrashield/db"
import { GET } from "./route"

describe("GET /api/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { role: "MEMBER" },
    })
    vi.mocked(prisma.project.findMany).mockResolvedValue([])
  })

  it("routes authorization through requireWorkspaceAccess and returns projects", async () => {
    const response = await GET(new Request("http://localhost:3000/api/projects?workspaceId=ws-1"))

    expect(requireWorkspaceAccess).toHaveBeenCalledWith("ws-1")
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1" }) })
    )
    expect(response.status).toBe(200)
  })

  it("returns 403 for a credential bound to another workspace", async () => {
    requireWorkspaceAccess.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await GET(new Request("http://localhost:3000/api/projects?workspaceId=ws-2"))

    expect(response.status).toBe(403)
    expect(prisma.project.findMany).not.toHaveBeenCalled()
  })

  it("returns 401 when unauthenticated", async () => {
    requireWorkspaceAccess.mockRejectedValue(new Error("UNAUTHORIZED"))

    const response = await GET(new Request("http://localhost:3000/api/projects?workspaceId=ws-1"))

    expect(response.status).toBe(401)
    expect(prisma.project.findMany).not.toHaveBeenCalled()
  })
})
