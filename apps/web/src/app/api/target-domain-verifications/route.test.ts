import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: { targetDomainVerification: { findMany: vi.fn() } },
  issueDnsDomainVerification: vi.fn(),
  verifyDnsDomainVerification: vi.fn(),
  LiveAiSafetyError: class LiveAiSafetyError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { target: { validate: "target:validate" } } }))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { issueDnsDomainVerification, prisma, verifyDnsDomainVerification } from "@lyrashield/db"
import { GET, POST, PUT } from "./route"

const jsonRequest = (method: string, body: unknown) =>
  new Request("https://app.lyrashieldai.com/api/target-domain-verifications", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

describe("target domain verification route", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns only private metadata when listing proofs", async () => {
    vi.mocked(prisma.targetDomainVerification.findMany).mockResolvedValue([] as never)
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/target-domain-verifications?workspaceId=ws-1")
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("returns the DNS challenge only to the authorized issuance response", async () => {
    vi.mocked(issueDnsDomainVerification).mockResolvedValue({
      verification: { id: "proof-1", domain: "staging.example.com", status: "PENDING" },
      token: "proof-token",
      expiresAt: new Date("2026-08-14T01:00:00.000Z"),
    } as never)
    const response = await POST(
      jsonRequest("POST", { workspaceId: "ws-1", domain: "staging.example.com" })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      data: { dns: { host: "_lyrashield.staging.example.com", value: "proof-token" } },
    })
  })

  it("returns a non-cacheable conflict when DNS proof is not yet visible", async () => {
    vi.mocked(verifyDnsDomainVerification).mockRejectedValue(
      new (await import("@lyrashield/db")).LiveAiSafetyError("DOMAIN_VERIFICATION_PROOF_NOT_FOUND")
    )
    const response = await PUT(
      jsonRequest("PUT", { workspaceId: "ws-1", verificationId: "proof-1" })
    )
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("DOMAIN_VERIFICATION_PROOF_NOT_FOUND")
  })
})
