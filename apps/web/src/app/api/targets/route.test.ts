import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((callback) => callback),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    integration: { findFirst: vi.fn() },
    target: { create: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
  },
}))

const requireWorkspaceAccess = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(),
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))

vi.mock("@/lib/target-domain-status", () => ({
  getTargetDomainStatuses: vi.fn(async () => new Map()),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { target: { create: "target:create" } },
}))

vi.mock("@lyrashield/security", () => ({
  checkScanUrlSafe: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}))

vi.mock("@lyrashield/billing", () => ({
  assertTargetAllowed: vi.fn(),
}))

import { prisma } from "@lyrashield/db"
import { assertTargetAllowed } from "@lyrashield/billing"
import { GET, POST } from "./route"

describe("GET /api/targets", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { role: "MEMBER" },
    })
    vi.mocked(prisma.target.findMany).mockResolvedValue([])
  })

  it("routes authorization through requireWorkspaceAccess and returns targets", async () => {
    const response = await GET(new Request("http://localhost:3000/api/targets?workspaceId=ws-1"))

    expect(requireWorkspaceAccess).toHaveBeenCalledWith("ws-1")
    expect(prisma.target.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1" }) })
    )
    expect(response.status).toBe(200)
  })

  it("returns 403 for a credential bound to another workspace", async () => {
    requireWorkspaceAccess.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await GET(new Request("http://localhost:3000/api/targets?workspaceId=ws-2"))

    expect(response.status).toBe(403)
    expect(prisma.target.findMany).not.toHaveBeenCalled()
  })

  it("returns 401 when unauthenticated", async () => {
    requireWorkspaceAccess.mockRejectedValue(new Error("UNAUTHORIZED"))

    const response = await GET(new Request("http://localhost:3000/api/targets?workspaceId=ws-1"))

    expect(response.status).toBe(401)
    expect(prisma.target.findMany).not.toHaveBeenCalled()
  })
})

describe("POST /api/targets", () => {
  beforeEach(() => vi.clearAllMocks())

  it("rejects a new target when the trial target cap is reached", async () => {
    vi.mocked(assertTargetAllowed).mockResolvedValue({
      allowed: false,
      code: "TARGET_LIMIT_REACHED",
      message: "Your trial allows up to 3 targets. Upgrade for more.",
      targetsUsed: 3,
      targetCap: 3,
    })

    const response = await POST(
      new Request("http://localhost:3000/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          type: "REPO",
          name: "Fourth target",
          repoOwner: "ecryptoguru",
          repoName: "fourth-target",
        }),
      })
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "TARGET_LIMIT_REACHED",
        details: { targetsUsed: 3, targetCap: 3 },
      },
    })
    expect(prisma.target.create).not.toHaveBeenCalled()
  })
})
