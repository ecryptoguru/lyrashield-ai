import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

const getFinding = vi.fn()
const requirePermission = vi.fn()

vi.mock("@lyrashield/db", () => ({
  getFinding,
  prisma: { auditLog: { create: vi.fn() } },
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

const { GET } = await import("./route")

describe("GET /api/findings/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
  })

  it("never serializes raw evidence storage URIs even when the service result contains them", async () => {
    getFinding.mockResolvedValue({
      id: "finding-1",
      title: "Secret in source",
      summary: "summary",
      severity: "HIGH",
      status: "OPEN",
      verified: false,
      confidence: "medium",
      category: "Secrets",
      cwe: "CWE-798",
      cvssScore: 7.5,
      recommendedFix: "Rotate and remove",
      businessImpact: null,
      exploitability: null,
      verificationStatus: "DETECTED",
      verificationMethod: null,
      verificationReason: null,
      statusReason: null,
      scanId: "scan-1",
      evidence: [
        {
          id: "evidence-1",
          type: "finding",
          storageUri: "s3://evidence-bucket/evidence/ws-1/artifact.enc",
          redactionStatus: "complete",
        },
      ],
      verificationReceipts: [
        {
          id: "receipt-1",
          status: "VALIDATED",
          method: "RETEST",
          reason: "Deterministic clean retest",
          scanId: "scan-2",
          sourceRevision: "a".repeat(40),
          verifierVersion: "result-integrity-v3",
          evidence: { retestId: "retest-1", scannerSource: "secrets" },
          createdAt: new Date().toISOString(),
        },
      ],
      fixProposals: [],
      retests: [],
    } as never)

    const response = await GET(new Request("http://localhost/api/findings/finding-1?workspaceId=ws-1"), {
      params: Promise.resolve({ id: "finding-1" }),
    })
    const body = await response.json()

    const serialized = JSON.stringify(body)
    expect(response.status).toBe(200)
    expect(serialized).not.toContain("storageUri")
    expect(serialized).not.toContain("s3://")
    expect(serialized).not.toContain("evidence-bucket")
    expect(serialized).toContain("result-integrity-v3")
  })
})
