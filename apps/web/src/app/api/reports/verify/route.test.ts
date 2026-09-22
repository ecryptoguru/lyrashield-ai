import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  confirm: vi.fn(),
  publicKey: vi.fn(),
  rateLimit: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  verifyLaunchReportSignature: mocks.verify,
  confirmSharedLaunchReportIdentity: mocks.confirm,
}))
vi.mock("@lyrashield/billing", () => ({
  resolveLaunchReportSigningPublicKey: mocks.publicKey,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))
vi.mock("../../../../lib/rate-limit", () => ({
  clientIpFromRequest: () => "127.0.0.1",
  checkApiRateLimit: mocks.rateLimit,
}))

const { POST } = await import("./route")

const checksum = "a".repeat(64)
const reportId = "cm12345678901234567890123"
const shareToken = "b".repeat(64)

function request(body: unknown) {
  return new Request("http://localhost/api/reports/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/reports/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rateLimit.mockResolvedValue({ limited: false })
    mocks.publicKey.mockResolvedValue("public-key")
    mocks.verify.mockReturnValue(true)
    mocks.confirm.mockResolvedValue("MATCH")
  })

  it("keeps checksum-only verification backward compatible", async () => {
    const response = await POST(request({ reportChecksum: checksum, signature: "signature" }))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { verified: true, signingKeyId: "lyrashield-launch-report-ed25519-1" },
    })
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it("confirms an expected identity only after signature verification", async () => {
    const releaseIdentity = {
      reportId,
      shareToken,
      kind: "COMMIT",
      value: "c".repeat(40),
    }
    const response = await POST(
      request({ reportChecksum: checksum, signature: "signature", releaseIdentity })
    )
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { verified: true, releaseIdentity: { status: "MATCH" } },
    })
    expect(mocks.confirm).toHaveBeenCalledWith({
      reportId,
      token: shareToken,
      reportChecksum: checksum,
      identity: { kind: "COMMIT", value: "c".repeat(40) },
    })
  })

  it("does not query provenance when the signature is invalid", async () => {
    mocks.verify.mockReturnValue(false)
    const response = await POST(
      request({
        reportChecksum: checksum,
        signature: "invalid",
        releaseIdentity: {
          reportId,
          shareToken,
          kind: "ARTIFACT_DIGEST",
          value: `sha256:${"d".repeat(64)}`,
        },
      })
    )
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { verified: false, releaseIdentity: { status: "UNAVAILABLE" } },
    })
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it("rejects identity values that do not match their declared kind", async () => {
    const response = await POST(
      request({
        reportChecksum: checksum,
        signature: "signature",
        releaseIdentity: {
          reportId,
          shareToken,
          kind: "COMMIT",
          value: `sha256:${"d".repeat(64)}`,
        },
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
})
