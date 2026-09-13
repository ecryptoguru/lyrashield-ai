import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((callback) => callback),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

const { TargetNotFoundErrorMock, TargetHasActiveScanErrorMock, softDeleteTargetMock } = vi.hoisted(
  () => {
    class TargetNotFoundErrorMock extends Error {
      readonly code = "TARGET_NOT_FOUND"
    }
    class TargetHasActiveScanErrorMock extends Error {
      readonly code = "TARGET_HAS_ACTIVE_SCAN"
    }
    return {
      TargetNotFoundErrorMock,
      TargetHasActiveScanErrorMock,
      softDeleteTargetMock: vi.fn(),
    }
  }
)

vi.mock("@lyrashield/db", () => ({
  prisma: { auditLog: { create: vi.fn() }, target: { findFirst: vi.fn() } },
  withWorkspaceRLS: vi.fn(),
  softDeleteTarget: (...args: unknown[]) => softDeleteTargetMock(...args),
  TargetNotFoundError: TargetNotFoundErrorMock,
  TargetHasActiveScanError: TargetHasActiveScanErrorMock,
}))

const requirePermission = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(),
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { target: { delete: "target:delete", update: "target:update" } },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { DELETE } from "./route"

function req(id: string, workspaceId?: string): Request {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""
  return new Request(`http://localhost:3000/api/targets/${id}${qs}`, { method: "DELETE" })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

describe("DELETE /api/targets/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
  })

  it("returns 204 on success and routes through target.delete", async () => {
    softDeleteTargetMock.mockResolvedValue({ id: "t-1" })

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(204)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "target:delete")
    expect(softDeleteTargetMock).toHaveBeenCalledWith("ws-1", "t-1", "user-1")
  })

  it("returns 409 with TARGET_HAS_ACTIVE_SCAN when a scan is queued or running", async () => {
    softDeleteTargetMock.mockRejectedValue(new TargetHasActiveScanErrorMock())

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe("TARGET_HAS_ACTIVE_SCAN")
  })

  it("returns 404 when the target is missing or already deleted", async () => {
    softDeleteTargetMock.mockRejectedValue(new TargetNotFoundErrorMock())

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("TARGET_NOT_FOUND")
  })

  it("returns 403 when the caller lacks target.delete", async () => {
    requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const res = await DELETE(req("t-1", "ws-1"), ctx("t-1"))

    expect(res.status).toBe(403)
    expect(softDeleteTargetMock).not.toHaveBeenCalled()
  })

  it("returns 400 without workspaceId", async () => {
    const res = await DELETE(req("t-1"), ctx("t-1"))

    expect(res.status).toBe(400)
    expect(softDeleteTargetMock).not.toHaveBeenCalled()
  })
})
