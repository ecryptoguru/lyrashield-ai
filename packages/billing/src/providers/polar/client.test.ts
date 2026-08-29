import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  createCustomerSession: vi.fn(),
  env: {
    POLAR_ACCESS_TOKEN: "polar-sandbox-token",
    POLAR_ENVIRONMENT: "sandbox" as "production" | "sandbox",
  },
}))

vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    customerSessions = { create: mocks.createCustomerSession }

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

  it("creates a customer session and returns its portal URL", async () => {
    mocks.createCustomerSession.mockResolvedValueOnce({
      customerPortalUrl: "https://sandbox.polar.sh/customer-portal/session",
    })

    await expect(getPolarPortalUrl({ customerId: "cust_1" })).resolves.toBe(
      "https://sandbox.polar.sh/customer-portal/session"
    )
    expect(mocks.createCustomerSession).toHaveBeenCalledWith({ customerId: "cust_1" })
  })

  it("fails closed when Polar refuses the customer session", async () => {
    mocks.createCustomerSession.mockRejectedValueOnce(new Error("forbidden"))

    await expect(getPolarPortalUrl({ customerId: "cust_1" })).resolves.toBeNull()
  })
})
