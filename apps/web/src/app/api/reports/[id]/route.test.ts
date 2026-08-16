import { beforeEach, describe, expect, it, vi } from "vitest"

const generateShareToken = vi.fn()
const revokeShareToken = vi.fn()
const getShareableReport = vi.fn()

vi.mock("@lyrashield/db", () => ({
  generateShareToken: (...args: unknown[]) => generateShareToken(...args),
  revokeShareToken: (...args: unknown[]) => revokeShareToken(...args),
  getShareableReport: (...args: unknown[]) => getShareableReport(...args),
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { role: "OWNER", member: {} },
  }),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from "./route"

function actionRequest(body: unknown) {
  return new Request("http://localhost/api/reports/report-1", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/reports/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getShareableReport.mockResolvedValue({ id: "report-1", status: "generated" })
  })

  describe("action: share", () => {
    it("returns the share payload WITHOUT tokenHash", async () => {
      generateShareToken.mockResolvedValue({
        token: "a".repeat(64),
        tokenHash: "b".repeat(64),
        expiresAt: new Date("2026-09-15T00:00:00Z"),
      })

      const response = await POST(actionRequest({ workspaceId: "ws-1", action: "share" }), {
        params: Promise.resolve({ id: "report-1" }),
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      // The client has no legitimate use for a hash of the bearer token it already
      // holds — pin the exact key set so the hash cannot silently return.
      expect(Object.keys(body.data).sort()).toEqual(["expiresAt", "shareUrl", "token"])
      expect(body.data.token).toBe("a".repeat(64))
      expect(body.data.shareUrl).toBe(`/reports/shared/report-1?token=${"a".repeat(64)}`)
      expect(JSON.stringify(body)).not.toContain("tokenHash")
    })

    it("404s when the report does not exist in the workspace", async () => {
      getShareableReport.mockResolvedValue(null)

      const response = await POST(actionRequest({ workspaceId: "ws-1", action: "share" }), {
        params: Promise.resolve({ id: "report-1" }),
      })

      expect(response.status).toBe(404)
      expect(generateShareToken).not.toHaveBeenCalled()
    })
  })

  describe("action: revoke", () => {
    it("still returns the revocation timestamp", async () => {
      revokeShareToken.mockResolvedValue(new Date("2026-08-16T00:00:00Z"))

      const response = await POST(actionRequest({ workspaceId: "ws-1", action: "revoke" }), {
        params: Promise.resolve({ id: "report-1" }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: { revoked: true, revokedAt: "2026-08-16T00:00:00.000Z" },
      })
    })
  })
})
