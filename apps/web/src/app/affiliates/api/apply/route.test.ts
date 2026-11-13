import { beforeEach, describe, expect, it, vi } from "vitest"

const prismaMock = vi.hoisted(() => ({
  affiliate: { findUnique: vi.fn(), create: vi.fn() },
  user: { findUnique: vi.fn() },
  click: { count: vi.fn() },
}))

vi.mock("@lyrashield/db", () => ({ prisma: prismaMock }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getCachedSessionMock = vi.fn()
vi.mock("@/lib/cache", () => ({ getCachedSession: () => getCachedSessionMock() }))

import { POST } from "./route"

function request() {
  const form = new FormData()
  form.set("name", "Partner One")
  form.set("website", "https://partner.example.com")
  form.set("audienceSize", "1k-10k")
  form.set("audienceType", "developers")
  form.set("promotionMethods", "Newsletter and conference talks about developer security.")
  form.set("payoutMethod", "")
  form.set("acceptTerms", "true")
  form.set("taxFormStatus", "will_complete")
  return new Request("http://localhost/affiliates/api/apply", { method: "POST", body: form })
}

describe("affiliate apply — new admission is frozen", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSessionMock.mockResolvedValue({ userId: "user-1" })
  })

  it("returns a not-open-yet response for a browser session", async () => {
    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      success: false,
      error: "Affiliate applications are not open yet.",
    })
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("writes no Affiliate row and reads no application state", async () => {
    await POST(request())

    expect(prismaMock.affiliate.create).not.toHaveBeenCalled()
    expect(prismaMock.affiliate.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.click.count).not.toHaveBeenCalled()
  })

  it("stays closed even when a valid application body is submitted", async () => {
    // The full, previously accepted body must not reopen admission.
    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(prismaMock.affiliate.create).not.toHaveBeenCalled()
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "user-1", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])("still rejects workspace-bound credentials before the closed response", async (credential) => {
    getCachedSessionMock.mockResolvedValue({ userId: "user-1", ...credential })

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(prismaMock.affiliate.create).not.toHaveBeenCalled()
  })

  it("requires authentication before the closed response", async () => {
    getCachedSessionMock.mockResolvedValue(null)

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(prismaMock.affiliate.create).not.toHaveBeenCalled()
  })
})
