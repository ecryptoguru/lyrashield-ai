import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
    NEXT_PUBLIC_MARKETING_URL: "https://lyrashieldai.com",
  } as Record<string, string | undefined>,
  provider: "razorpay",
}))

vi.mock("@lyrashield/config", () => ({ env: state.env }))
vi.mock("@lyrashield/auth/server", () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: "user_1" }),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspaceMember: {
      findFirst: vi.fn().mockResolvedValue({ workspaceId: "ws_1" }),
    },
    billingAccount: {
      findUnique: vi.fn().mockImplementation(async () => ({
        externalId: "cust_1",
        provider: state.provider,
      })),
    },
  },
}))
vi.mock("@lyrashield/billing", () => ({
  getPolarPortalUrl: vi.fn().mockResolvedValue("https://polar.example/portal"),
}))

const { GET } = await import("./route")

describe("GET /billing/portal", () => {
  it("redirects Razorpay customers to the explicit billing support path", async () => {
    const response = await GET()
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe(
      "https://lyrashieldai.com/support?topic=billing&provider=razorpay"
    )
  })

  it("redirects Polar customers to the hosted portal", async () => {
    state.provider = "polar"
    try {
      const response = await GET()
      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe("https://polar.example/portal")
    } finally {
      state.provider = "razorpay"
    }
  })

  it("fails closed with an explicit configuration error instead of interpolating undefined", async () => {
    state.env.NEXT_PUBLIC_MARKETING_URL = undefined
    try {
      const response = await GET()
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
      const response = await GET()
      expect(response.headers.get("location") ?? "").not.toContain("undefined")
    } finally {
      state.env.NEXT_PUBLIC_MARKETING_URL = "https://lyrashieldai.com"
    }
  })
})
