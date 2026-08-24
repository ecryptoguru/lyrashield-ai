import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  issueSignedLicense: vi.fn(),
  encryptRetrievalKey: vi.fn((raw: string) => `encrypted:${raw}`),
  licenseKeyCreate: vi.fn(),
  licenseKeyUpdate: vi.fn(),
  licenseKeyUpdateMany: vi.fn(),
  licenseKeyFindFirst: vi.fn(),
  licenseFindUniqueOrThrow: vi.fn(),
  transaction: vi.fn(),
}))

const tx = {
  license: { create: vi.fn().mockResolvedValue({ id: "lic_new" }) },
  licenseKey: { create: mocks.licenseKeyCreate },
}

const systemPrisma = {
  $transaction: mocks.transaction,
  licenseKey: {
    update: mocks.licenseKeyUpdate,
    updateMany: mocks.licenseKeyUpdateMany,
    findFirst: mocks.licenseKeyFindFirst,
  },
  license: { findUniqueOrThrow: mocks.licenseFindUniqueOrThrow },
}

vi.mock("@lyrashield/db", () => ({
  prisma: { auditLog: { create: vi.fn() } },
  getSystemPrisma: () => systemPrisma,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({
  teamVolumeDiscountPct: () => 0,
  teamOrderTotal: () => 199,
}))
vi.mock("../../../../lib/licenses/license-service", () => ({
  generateLicenseKey: () => "LYRA-RAW-KEY",
  hashLicenseKey: () => "key-hash",
  generateRetrievalToken: () => "retrieval-token-long-enough",
  hashRetrievalToken: () => "retrieval-token-hash",
  encryptRetrievalKey: mocks.encryptRetrievalKey,
  RETRIEVAL_TOKEN_EXPIRY_MS: 60_000,
  FULFILLMENT_STATUS: {
    MINTED: "MINTED",
    DELIVERING: "DELIVERING",
    DELIVERED: "DELIVERED",
    DELIVERY_FAILED: "DELIVERY_FAILED",
  },
  computeUpdateEligibleUntil: () => new Date("2030-01-01T00:00:00.000Z"),
  issueSignedLicense: mocks.issueSignedLicense,
  parseLocalProductIds: () => ({ individual_regular: "prod_local" }),
  requireInternalApiKey: () => null,
  resolvePublishedFallbackBuild: () => "1.0.0",
  sendLicenseRetrievalEmail: mocks.sendEmail,
  validateSeatCountForSku: () => undefined,
}))

import { POST } from "./route"

function request() {
  return new Request("http://localhost/api/licenses/issue", {
    method: "POST",
    body: JSON.stringify({
      productId: "prod_local",
      buyerEmail: "buyer@example.com",
      seatCount: 1,
      orderId: "order_1",
    }),
  })
}

describe("POST /api/licenses/issue", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tx.license.create.mockResolvedValue({ id: "lic_new" })
    mocks.transaction.mockImplementation(async (callback) => callback(tx))
    mocks.issueSignedLicense.mockResolvedValue({ signature: "signed" })
    mocks.sendEmail.mockResolvedValue(undefined)
    mocks.licenseKeyUpdate.mockResolvedValue({})
    mocks.licenseKeyUpdateMany.mockResolvedValue({ count: 1 })
    mocks.licenseKeyFindFirst.mockResolvedValue(null)
  })

  it("encrypts retrieval material and returns retryable failure when email delivery fails", async () => {
    mocks.sendEmail.mockRejectedValueOnce(new Error("brevo unavailable"))

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get("Retry-After")).toBe("60")
    expect(body.error.code).toBe("LICENSE_DELIVERY_RETRYABLE")
    expect(mocks.encryptRetrievalKey).toHaveBeenCalledWith("LYRA-RAW-KEY")
    expect(mocks.licenseKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ retrievalRawKey: "encrypted:LYRA-RAW-KEY" }),
      })
    )
    expect(mocks.licenseKeyUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fulfillmentStatus: "DELIVERY_FAILED",
          lastDeliveryError: "brevo unavailable",
        }),
      })
    )
  })

  it("retries failed delivery for the same provider order with a fresh one-time token", async () => {
    mocks.transaction.mockRejectedValueOnce({ code: "P2002" })
    mocks.licenseKeyFindFirst.mockResolvedValueOnce({
      id: "key_1",
      licenseId: "lic_existing",
      fulfillmentStatus: "DELIVERY_FAILED",
    })
    mocks.licenseFindUniqueOrThrow.mockResolvedValueOnce({
      id: "lic_existing",
      sku: "individual_regular",
      ownerEmail: "buyer@example.com",
      perpetualFallbackBuild: "1.0.0",
    })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ licenseId: "lic_existing", alreadyIssued: true })
    expect(mocks.licenseKeyUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "key_1",
          fulfillmentStatus: "DELIVERY_FAILED",
        }),
        data: expect.objectContaining({
          fulfillmentStatus: "DELIVERING",
          retrievalTokenHash: "retrieval-token-hash",
          retrievalTokenUsedAt: null,
        }),
      })
    )
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
  })

  it("lets only one concurrent retry claim a failed delivery", async () => {
    mocks.transaction.mockRejectedValueOnce({ code: "P2002" })
    mocks.licenseKeyFindFirst.mockResolvedValueOnce({
      id: "key_1",
      licenseId: "lic_existing",
      fulfillmentStatus: "DELIVERY_FAILED",
    })
    mocks.licenseFindUniqueOrThrow.mockResolvedValueOnce({
      id: "lic_existing",
      sku: "individual_regular",
      ownerEmail: "buyer@example.com",
      perpetualFallbackBuild: "1.0.0",
    })
    mocks.licenseKeyUpdateMany.mockResolvedValueOnce({ count: 0 })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.issueSignedLicense).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it("rejects a retry addressed to a different buyer", async () => {
    mocks.transaction.mockRejectedValueOnce({ code: "P2002" })
    mocks.licenseKeyFindFirst.mockResolvedValueOnce({
      id: "key_1",
      licenseId: "lic_existing",
      fulfillmentStatus: "DELIVERY_FAILED",
    })
    mocks.licenseFindUniqueOrThrow.mockResolvedValueOnce({
      id: "lic_existing",
      sku: "individual_regular",
      ownerEmail: "original@example.com",
      perpetualFallbackBuild: "1.0.0",
    })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error.code).toBe("LICENSE_BUYER_MISMATCH")
    expect(mocks.licenseKeyUpdateMany).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it("does not invalidate an in-flight delivery token on a concurrent retry", async () => {
    mocks.transaction.mockRejectedValueOnce({ code: "P2002" })
    mocks.licenseKeyFindFirst.mockResolvedValueOnce({
      id: "key_1",
      licenseId: "lic_existing",
      fulfillmentStatus: "DELIVERING",
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.licenseKeyUpdate).not.toHaveBeenCalled()
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })
})
