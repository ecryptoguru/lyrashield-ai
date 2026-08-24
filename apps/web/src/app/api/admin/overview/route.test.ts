import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePlatformAdminIdentity = vi.fn()
const getPlatformAdminOverview = vi.fn()

vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity: (...args: unknown[]) => requirePlatformAdminIdentity(...args),
}))
vi.mock("@/lib/platform-admin-overview", () => ({
  getPlatformAdminOverview: () => getPlatformAdminOverview(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET } from "./route"

describe("GET /api/admin/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "admin-1" })
    getPlatformAdminOverview.mockResolvedValue({ generatedAt: "2026-08-24T00:00:00.000Z" })
  })

  it("returns private, non-referring platform health to an elevated admin", async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { generatedAt: "2026-08-24T00:00:00.000Z" },
    })
  })

  it.each([
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
  ])("maps %s without reading platform data", async (message, status) => {
    requirePlatformAdminIdentity.mockRejectedValue(new Error(message))

    const response = await GET()

    expect(response.status).toBe(status)
    expect(getPlatformAdminOverview).not.toHaveBeenCalled()
  })
})
