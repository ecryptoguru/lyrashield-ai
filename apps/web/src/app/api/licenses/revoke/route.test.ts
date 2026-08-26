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
  return new Request("https://app.lyrashieldai.com/api/licenses/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify({ licenseId: "license-1", reason: "compromised" }),
  })
}

describe("POST /api/licenses/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "admin-1" })
  })

  it("keeps license revocation explicitly disabled", async () => {
    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "ADMIN_ACTION_DISABLED" },
    })
  })

  it("returns 401 before browser-boundary validation when no admin is authenticated", async () => {
    requirePlatformAdminIdentity.mockRejectedValueOnce(new Error("UNAUTHORIZED"))

    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/licenses/revoke", { method: "POST" })
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "UNAUTHORIZED" },
    })
  })

  it("rejects cross-origin requests after identity verification", async () => {
    const response = await POST(
      request({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })
    )

    expect(response.status).toBe(403)
    expect(requirePlatformAdminIdentity).toHaveBeenCalledOnce()
  })
})
