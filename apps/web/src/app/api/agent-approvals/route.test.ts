import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  createApproval: vi.fn(),
  listApprovals: vi.fn(),
}))

const requirePermission = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { agent: { act: "agent:act", view: "agent:view" } },
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn() },
}))

const checkApprovalCreateRateLimit = vi.fn()
vi.mock("../../../lib/rate-limit", () => ({
  checkApprovalCreateRateLimit: (...args: unknown[]) => checkApprovalCreateRateLimit(...args),
}))

import { createApproval } from "@lyrashield/db"
import { POST } from "./route"

function request(body: unknown) {
  return new Request("http://localhost/api/agent-approvals", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const VALID_BODY = {
  workspaceId: "ws-1",
  actionName: "run_custom_scan",
  input: { targetId: "target-1" },
}

describe("POST /api/agent-approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { role: "DEVELOPER" },
    })
    checkApprovalCreateRateLimit.mockResolvedValue({ limited: false })
    vi.mocked(createApproval).mockResolvedValue({ id: "approval-1" } as never)
  })

  it("creates an approval with the default 15-minute expiry when none is given", async () => {
    const before = Date.now()
    const response = await POST(request(VALID_BODY))

    expect(response.status).toBe(201)
    const expiresAt = vi.mocked(createApproval).mock.calls[0]![0].expiresAt
    expect(expiresAt).toBeInstanceOf(Date)
    expect(expiresAt!.getTime() - before).toBeLessThanOrEqual(15 * 60 * 1000 + 5_000)
    expect(expiresAt!.getTime()).toBeGreaterThan(before)
  })

  it("accepts a caller-chosen expiry inside the maximum lifetime", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const response = await POST(request({ ...VALID_BODY, expiresAt }))

    expect(response.status).toBe(201)
    expect(vi.mocked(createApproval).mock.calls[0]![0].expiresAt).toEqual(new Date(expiresAt))
  })

  it("rejects an expiry beyond the server-side maximum lifetime", async () => {
    const response = await POST(
      request({ ...VALID_BODY, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() })
    )

    expect(response.status).toBe(400)
    expect(createApproval).not.toHaveBeenCalled()
  })

  it("rejects a never-expiring far-future expiry", async () => {
    const response = await POST(request({ ...VALID_BODY, expiresAt: "9999-01-01T00:00:00.000Z" }))

    expect(response.status).toBe(400)
    expect(createApproval).not.toHaveBeenCalled()
  })

  it("rejects a past or unparseable expiry", async () => {
    for (const expiresAt of ["2000-01-01T00:00:00.000Z", "not-a-date"]) {
      const response = await POST(request({ ...VALID_BODY, expiresAt }))

      expect(response.status).toBe(400)
      expect(createApproval).not.toHaveBeenCalled()
    }
  })
})
