import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com" } as Record<
    string,
    string | undefined
  >,
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
      findUnique: vi.fn().mockResolvedValue({
        externalId: "cust_1",
        provider: "razorpay",
      }),
    },
  },
}))
vi.mock("@lyrashield/billing", () => ({
  getPolarPortalUrl: vi.fn().mockResolvedValue("https://polar.example/portal"),
}))

const { GET } = await import("./route")

describe("GET /billing/portal — Razorpay fallback URL", () => {
  it("builds the dashboard fallback from validated config", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { url: string } }
    expect(body.data.url).toBe("https://app.lyrashieldai.com/dashboard/billing")
  })

  it("fails closed with an explicit configuration error instead of interpolating undefined", async () => {
    state.env.NEXT_PUBLIC_APP_URL = undefined
    try {
      const response = await GET()
      expect(response.status).toBe(503)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe("CONFIGURATION_ERROR")
    } finally {
      state.env.NEXT_PUBLIC_APP_URL = "https://app.lyrashieldai.com"
    }
  })

  it("never returns a URL containing an undefined interpolation", async () => {
    state.env.NEXT_PUBLIC_APP_URL = undefined
    try {
      const response = await GET()
      const body = (await response.json()) as { data?: { url?: string } }
      expect(body.data?.url ?? "").not.toContain("undefined")
    } finally {
      state.env.NEXT_PUBLIC_APP_URL = "https://app.lyrashieldai.com"
    }
  })
})
