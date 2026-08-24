import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
    NEXT_PUBLIC_MARKETING_URL: "https://lyrashieldai.com",
  } as Record<string, string | undefined>,
  provider: "razorpay",
  requirePermission: vi.fn(),
  findBillingAccount: vi.fn().mockImplementation(async () => ({
    externalId: "cust_1",
    provider: "razorpay",
  })),
  getPolarPortalUrl: vi.fn().mockResolvedValue("https://polar.example/portal"),
}))

vi.mock("@lyrashield/config", () => ({ env: state.env }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { billing: { manage: "billing:manage" } },
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: state.requirePermission,
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    billingAccount: {
      findUnique: state.findBillingAccount,
    },
  },
}))
vi.mock("@lyrashield/billing", () => ({
  getPolarPortalUrl: state.getPolarPortalUrl,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

const { GET } = await import("./route")

function request(workspaceId = "ws_1") {
  return new Request(
    `https://app.lyrashieldai.com/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`
  )
}

describe("GET /billing/portal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.provider = "razorpay"
    state.env.NEXT_PUBLIC_MARKETING_URL = "https://lyrashieldai.com"
    state.findBillingAccount.mockImplementation(async () => ({
      externalId: "cust_1",
      provider: state.provider,
    }))
  })

  it("requires an explicit workspace", async () => {
    const response = await GET(new Request("https://app.lyrashieldai.com/billing/portal"))
    expect(response.status).toBe(400)
    expect(state.requirePermission).not.toHaveBeenCalled()
    expect(state.findBillingAccount).not.toHaveBeenCalled()
  })

  it("fails closed when the caller cannot manage billing", async () => {
    state.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))

    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(state.requirePermission).toHaveBeenCalledWith("ws_1", "billing:manage")
    expect(state.findBillingAccount).not.toHaveBeenCalled()
    expect(state.getPolarPortalUrl).not.toHaveBeenCalled()
  })

  it("redirects Razorpay customers to the explicit billing support path", async () => {
    const response = await GET(request())
    expect(response.status).toBe(307)
    expect(state.requirePermission).toHaveBeenCalledWith("ws_1", "billing:manage")
    expect(state.findBillingAccount).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1" },
      select: { externalId: true, provider: true },
    })
    expect(response.headers.get("location")).toBe(
      "https://lyrashieldai.com/support?topic=billing&provider=razorpay"
    )
  })

  it("redirects Polar customers to the hosted portal", async () => {
    state.provider = "polar"
    try {
      const response = await GET(request())
      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe("https://polar.example/portal")
    } finally {
      state.provider = "razorpay"
    }
  })

  it("fails closed with an explicit configuration error instead of interpolating undefined", async () => {
    state.env.NEXT_PUBLIC_MARKETING_URL = undefined
    try {
      const response = await GET(request())
      expect(response.status).toBe(503)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe("CONFIGURATION_ERROR")
    } finally {
      state.env.NEXT_PUBLIC_MARKETING_URL = "https://lyrashieldai.com"
    }
  })

  it("never returns a URL containing an undefined interpolation", async () => {
    state.env.NEXT_PUBLIC_MARKETING_URL = undefined
    try {
      const response = await GET(request())
      expect(response.headers.get("location") ?? "").not.toContain("undefined")
    } finally {
      state.env.NEXT_PUBLIC_MARKETING_URL = "https://lyrashieldai.com"
    }
  })
})
