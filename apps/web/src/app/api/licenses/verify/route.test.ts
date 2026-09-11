import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findLicense: vi.fn(),
  signReceipt: vi.fn(),
  verifyLicense: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => ({
    license: { findUnique: mocks.findLicense },
    licenseKey: { findUnique: vi.fn() },
  }),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
vi.mock("@lyrashield/licenses", () => ({
  signRevalidationReceipt: mocks.signReceipt,
  verifyLicense: mocks.verifyLicense,
}))
vi.mock("../../../../lib/licenses/license-service", () => ({
  hashLicenseKey: vi.fn(),
  resolveSigningKeyId: () => "test-key",
  resolveSigningPrivateKey: () => "private-key",
  resolveSigningPublicKey: () => "public-key",
}))
vi.mock("../../../../lib/rate-limit", () => ({
  clientIpFromRequest: () => "203.0.113.4",
  checkLicenseApiRateLimit: () => ({ limited: false }),
}))

import { POST } from "./route"

const licenseFile = {
  sku: "individual_regular",
  seatCount: 1,
  machineIds: ["machine-1"],
  updateEligibleUntil: "2027-01-01T00:00:00.000Z",
  perpetualFallbackBuild: "1.0.0",
  signingKeyId: "test-key",
  signature: "license-signature",
  issuedAt: "2026-01-01T00:00:00.000Z",
}

function request() {
  return new Request("http://localhost/api/licenses/verify", {
    method: "POST",
    body: JSON.stringify({ licenseId: "lic_1", licenseFile }),
  })
}

describe("POST /api/licenses/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findLicense.mockResolvedValue({
      id: "lic_1",
      revoked: false,
      signature: licenseFile.signature,
    })
    mocks.verifyLicense.mockReturnValue({ valid: true, updateEligible: true })
    mocks.signReceipt.mockReturnValue({
      licenseId: "lic_1",
      licenseSignature: licenseFile.signature,
      verifiedAt: "2026-09-11T00:00:00.000Z",
      expiresAt: "2026-09-18T00:00:00.000Z",
      signingKeyId: "test-key",
      signature: "receipt-signature",
    })
  })

  it("rejects a signed file that is not bound to the identified license", async () => {
    mocks.findLicense.mockResolvedValue({ id: "lic_1", revoked: false, signature: "other" })

    const response = await POST(request())
    const body = await response.json()

    expect(body.data).toMatchObject({ valid: false, reason: "LICENSE_MISMATCH" })
    expect(mocks.verifyLicense).not.toHaveBeenCalled()
    expect(mocks.signReceipt).not.toHaveBeenCalled()
  })

  it("returns a signed receipt bound to the license and signed file", async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(body.data.valid).toBe(true)
    expect(body.data.revalidationReceipt.signature).toBe("receipt-signature")
    expect(mocks.signReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ licenseId: "lic_1", licenseSignature: licenseFile.signature }),
      "private-key",
      "test-key"
    )
  })
})
