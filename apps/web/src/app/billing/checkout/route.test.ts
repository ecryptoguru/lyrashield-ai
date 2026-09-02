import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  provider: "polar" as "polar" | "razorpay",
  admissionResponse: null as Response | null,
  checkoutClaim: "claimed" as "claimed" | "duplicate" | "unavailable",
  createPolar: vi.fn().mockResolvedValue("https://polar.example/checkout"),
  createRazorpay: vi.fn().mockResolvedValue("sub_1"),
  workspace: vi.fn(),
  billingAccount: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: { findUnique: mocks.workspace },
    billingAccount: { findUnique: mocks.billingAccount },
  },
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: vi.fn() }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock("@lyrashield/affiliate", () => ({ resolveAttribution: vi.fn().mockResolvedValue(null) }))
vi.mock("@/lib/rate-limit", () => ({
  checkBillingCheckoutRateLimit: vi.fn(() => ({ limited: false })),
  claimBillingCheckoutCreation: vi.fn(() => mocks.checkoutClaim),
}))
vi.mock("@/lib/billing-admission", () => ({
  billingAdmissionError: () => mocks.admissionResponse,
  resolveRequestBillingProvider: () => ({
    provider: mocks.provider,
    region: mocks.provider === "polar" ? "usd" : "inr",
  }),
  paymentsUnavailableError: () =>
    Response.json({ success: false, error: { code: "PAYMENTS_UNAVAILABLE" } }, { status: 503 }),
}))
vi.mock("@lyrashield/config", () => ({
  env: {
    POLAR_PRODUCT_IDS: JSON.stringify({ starter_monthly: "prod_1" }),
    RAZORPAY_PLAN_IDS: JSON.stringify({ starter_monthly: "plan_1" }),
    RAZORPAY_KEY_ID: "rzp_test_key",
  },
}))
vi.mock("@lyrashield/billing", () => ({
  createPolarCheckout: mocks.createPolar,
  createRazorpaySubscription: mocks.createRazorpay,
  getRazorpaySubscriptionCycleCount: () => 1200,
  resolveProviderId: (raw: string, key: string) => JSON.parse(raw)[key] ?? null,
  CLOUD_PLAN_MAP: { STARTER: { selfServe: true } },
}))

import { POST } from "./route"

function request(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ workspaceId: "ws_1", plan: "STARTER", interval: "monthly", ...body }),
  })
}

describe("Cloud checkout admission", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.provider = "polar"
    mocks.admissionResponse = null
    mocks.checkoutClaim = "claimed"
    mocks.workspace.mockResolvedValue({ plan: "FREE" })
    mocks.billingAccount.mockResolvedValue(null)
  })

  it("stops before provider calls when admission is off", async () => {
    mocks.admissionResponse = Response.json({ success: false }, { status: 503 })
    expect((await POST(request())).status).toBe(503)
    expect(mocks.createPolar).not.toHaveBeenCalled()
  })

  it("creates admitted hosted checkouts on both rails", async () => {
    expect((await POST(request())).status).toBe(200)
    mocks.provider = "razorpay"
    expect((await POST(request())).status).toBe(200)
    expect(mocks.createPolar).toHaveBeenCalledOnce()
    expect(mocks.createRazorpay).toHaveBeenCalledOnce()
  })

  it.each(["STARTER", "PRO", "LAUNCH_ASSURANCE"])(
    "rejects paid %s on both rails before provider calls",
    async (plan) => {
      mocks.workspace.mockResolvedValue({ plan })
      mocks.billingAccount.mockResolvedValue({ currentPlan: plan })
      for (const provider of ["polar", "razorpay"] as const) {
        mocks.provider = provider
        const response = await POST(request())
        expect(response.status).toBe(409)
        expect((await response.json()).error.code).toBe("SUBSCRIPTION_ALREADY_EXISTS")
      }
      expect(mocks.createPolar).not.toHaveBeenCalled()
      expect(mocks.createRazorpay).not.toHaveBeenCalled()
    }
  )

  it("fails closed when the billing account is paid but workspace plan is stale", async () => {
    mocks.billingAccount.mockResolvedValue({ currentPlan: "PRO" })
    expect((await POST(request())).status).toBe(409)
    expect(mocks.createPolar).not.toHaveBeenCalled()
    expect(mocks.createRazorpay).not.toHaveBeenCalled()
  })

  it("permits a FREE trial's first purchase on both rails", async () => {
    mocks.billingAccount.mockResolvedValue({ currentPlan: "FREE", status: "trialing" })
    for (const provider of ["polar", "razorpay"] as const) {
      mocks.provider = provider
      expect((await POST(request())).status).toBe(200)
    }
    expect(mocks.workspace).toHaveBeenCalledWith({ where: { id: "ws_1" }, select: { plan: true } })
    expect(mocks.billingAccount).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1" },
      select: { currentPlan: true },
    })
    expect(mocks.createPolar).toHaveBeenCalledOnce()
    expect(mocks.createRazorpay).toHaveBeenCalledOnce()
  })

  it("rejects client region overrides", async () => {
    expect((await POST(request({ region: "inr" }))).status).toBe(400)
    expect(mocks.createPolar).not.toHaveBeenCalled()
  })

  it("does not create a second provider subscription while checkout is in progress", async () => {
    mocks.checkoutClaim = "duplicate"
    expect((await POST(request())).status).toBe(409)
    expect(mocks.createPolar).not.toHaveBeenCalled()
  })
})
