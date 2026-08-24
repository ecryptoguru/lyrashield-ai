import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  activationCount: vi.fn(),
  activationFindUnique: vi.fn(),
  activationUpdate: vi.fn(),
  issueSignedLicense: vi.fn(),
}))

const tx = {
  $queryRaw: vi.fn().mockResolvedValue([]),
  licenseActivation: {
    findUnique: mocks.activationFindUnique,
    count: mocks.activationCount,
    create: vi.fn(),
    update: mocks.activationUpdate,
    findMany: vi.fn(),
  },
  license: { update: vi.fn() },
}

const systemPrisma = {
  licenseKey: {
    findUnique: vi.fn().mockResolvedValue({
      license: {
        id: "lic_1",
        revoked: false,
        sku: "individual_regular",
        seatCount: 1,
        workspaceId: null,
        perpetualFallbackBuild: "1.0.0",
      },
    }),
  },
  $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
}

vi.mock("@lyrashield/db", () => ({
  prisma: { auditLog: { create: vi.fn() } },
  getSystemPrisma: () => systemPrisma,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("@lyrashield/licenses", () => ({ encodeLicenseBlob: vi.fn() }))
vi.mock("../../../../lib/licenses/license-service", () => ({
  hashLicenseKey: () => "key-hash",
  issueSignedLicense: mocks.issueSignedLicense,
  machineCapForSku: () => 3,
}))
vi.mock("../../../../lib/rate-limit", () => ({
  clientIpFromRequest: () => "203.0.113.4",
  checkLicenseApiRateLimit: () => ({ limited: false }),
}))

import { POST } from "./route"

describe("POST /api/licenses/activate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activationFindUnique.mockResolvedValue({
      id: "activation_old",
      deactivatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    mocks.activationCount.mockResolvedValue(3)
  })

  it("does not reactivate a deactivated fourth machine after the cap is full", async () => {
    const response = await POST(
      new Request("http://localhost/api/licenses/activate", {
        method: "POST",
        body: JSON.stringify({ licenseKey: "LYRA-KEY", machineId: "machine-004" }),
      })
    )
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error.code).toBe("MACHINE_CAP_REACHED")
    expect(mocks.activationCount).toHaveBeenCalledOnce()
    expect(mocks.activationUpdate).not.toHaveBeenCalled()
    expect(mocks.issueSignedLicense).not.toHaveBeenCalled()
  })
})
