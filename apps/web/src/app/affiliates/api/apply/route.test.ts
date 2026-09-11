import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    affiliate: { findUnique: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
    click: { count: vi.fn() },
  },
}))
vi.mock("@lyrashield/affiliate", () => ({
  detectFraudSignals: vi.fn(() => ({ block: false, signals: [] })),
  AFFILIATE_TERMS_VERSION: "2026-08-18-v1",
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@/lib/rate-limit", () => ({ clientIpFromRequest: vi.fn(() => "203.0.113.1") }))

const getCachedSessionMock = vi.fn()
vi.mock("@/lib/cache", () => ({ getCachedSession: () => getCachedSessionMock() }))

import { prisma } from "@lyrashield/db"
import { POST } from "./route"

const affiliate = prisma.affiliate as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}
const user = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const click = prisma.click as unknown as { count: ReturnType<typeof vi.fn> }

function request() {
  const form = new FormData()
  form.set("name", "Partner One")
  form.set("website", "https://partner.example.com")
  form.set("audienceSize", "1k-10k")
  form.set("audienceType", "developers")
  form.set("promotionMethods", "Newsletter and conference talks about developer security.")
  form.set("payoutMethod", "payoneer")
  form.set("acceptTerms", "true")
  form.set("taxFormStatus", "will_complete")
  return new Request("http://localhost/affiliates/api/apply", { method: "POST", body: form })
}

describe("affiliate apply", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSessionMock.mockResolvedValue({ userId: "user-1" })
    affiliate.findUnique.mockResolvedValue(null)
    user.findUnique.mockResolvedValue({ email: "user@example.com" })
    click.count.mockResolvedValue(0)
    affiliate.create.mockResolvedValue({ id: "aff-1" })
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "user-1", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])("rejects workspace-bound credentials — applications are browser-only", async (credential) => {
    getCachedSessionMock.mockResolvedValue({ userId: "user-1", ...credential })

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(affiliate.create).not.toHaveBeenCalled()
  })

  it("accepts a browser-session application", async () => {
    const response = await POST(request())

    expect(response.status).toBe(201)
    expect(affiliate.create).toHaveBeenCalled()
  })
})
