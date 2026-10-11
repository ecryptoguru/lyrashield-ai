import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  createCustomerSession: vi.fn(),
  getSubscription: vi.fn(),
  env: {
    POLAR_ACCESS_TOKEN: "polar-sandbox-token",
    POLAR_ENVIRONMENT: "sandbox" as "production" | "sandbox",
  },
}))

vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    customerSessions = { create: mocks.createCustomerSession }
    subscriptions = { get: mocks.getSubscription }

    constructor(options: unknown) {
      mocks.construct(options)
    }
  },
}))
vi.mock("@lyrashield/config", () => ({ env: mocks.env }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { getPolarClient, getPolarPortalUrl } from "./client"

describe("getPolarClient", () => {
  beforeEach(() => vi.clearAllMocks())

  it("passes the validated environment to the Polar SDK", () => {
    expect(getPolarClient()).not.toBeNull()
    expect(mocks.construct).toHaveBeenCalledWith({
      accessToken: "polar-sandbox-token",
      server: "sandbox",
    })
  })
})

describe("getPolarPortalUrl", () => {
  beforeEach(() => vi.clearAllMocks())

  it("resolves the stored subscription to its distinct customer before creating a portal session", async () => {
    mocks.getSubscription.mockResolvedValueOnce({ id: "sub_1", customerId: "cust_1" })
    mocks.createCustomerSession.mockResolvedValueOnce({
      customerPortalUrl: "https://sandbox.polar.sh/customer-portal/session",
    })

    await expect(getPolarPortalUrl({ subscriptionId: "sub_1" })).resolves.toBe(
      "https://sandbox.polar.sh/customer-portal/session"
    )
    expect(mocks.createCustomerSession).toHaveBeenCalledWith({ customerId: "cust_1" })
    expect(mocks.getSubscription).toHaveBeenCalledWith({ id: "sub_1" })
  })

  it("fails closed when Polar refuses the customer session", async () => {
    mocks.getSubscription.mockResolvedValueOnce({ id: "sub_1", customerId: "cust_1" })
    mocks.createCustomerSession.mockRejectedValueOnce(new Error("forbidden"))

    await expect(getPolarPortalUrl({ subscriptionId: "sub_1" })).resolves.toBeNull()
  })

  it.each([
    { id: "other", customerId: "cust_1" },
    { id: "sub_1", customerId: "" },
  ])("fails closed for a mismatched subscription or missing customer: %j", async (subscription) => {
    mocks.getSubscription.mockResolvedValueOnce(subscription)
    await expect(getPolarPortalUrl({ subscriptionId: "sub_1" })).resolves.toBeNull()
    expect(mocks.createCustomerSession).not.toHaveBeenCalled()
  })

  it("does not create a session when subscription lookup fails", async () => {
    mocks.getSubscription.mockRejectedValueOnce(new Error("not found"))
    await expect(getPolarPortalUrl({ subscriptionId: "sub_1" })).resolves.toBeNull()
    expect(mocks.createCustomerSession).not.toHaveBeenCalled()
  })
})
