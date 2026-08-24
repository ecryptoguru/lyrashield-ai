import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePlatformAdminIdentity = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity: (...args: unknown[]) => requirePlatformAdminIdentity(...args),
}))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com" },
}))

import { POST } from "./route"

function request(headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/admin/affiliates/action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      "x-lyrashield-admin-elevation": "A".repeat(43),
      ...headers,
    },
    body: JSON.stringify({ action: "reject", affiliateId: "affiliate-1" }),
  })
}

describe("POST /api/admin/affiliates/action", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "admin-1" })
  })

  it("keeps all affiliate mutations explicitly disabled", async () => {
    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "ADMIN_ACTION_DISABLED" },
    })
  })

  it("rejects cross-origin and missing-elevation requests before identity work", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { "x-lyrashield-admin-elevation": "" },
    ]) {
      const response = await POST(request(headers))
      expect(response.status).toBe(403)
    }
    expect(requirePlatformAdminIdentity).not.toHaveBeenCalled()
  })
})
