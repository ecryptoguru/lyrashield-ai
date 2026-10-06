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
const getFindingReference = vi.fn()
const markFalsePositive = vi.fn()
const acceptRisk = vi.fn()
const updateFindingStatus = vi.fn()
const auditLogCreate = vi.fn()
const validateFindingScope = vi.fn()
const requirePermission = vi.fn()

vi.mock("@lyrashield/db", () => ({
  getFinding,
  getFindingReference,
  markFalsePositive,
  acceptRisk,
  updateFindingStatus,
  validateFindingScope,
  prisma: {
    auditLog: { create: auditLogCreate },
    evidence: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}))
vi.mock("@lyrashield/evidence-storage", () => ({
  readEncryptedArtifact: vi.fn(),
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: {
    finding: {
      view: "finding:view",
      update: "finding:update",
      acceptRisk: "finding:accept_risk",
      falsePositive: "finding:false_positive",
    },
  },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

const { GET, PATCH } = await import("./route")
const { prisma } = await import("@lyrashield/db")
const { readEncryptedArtifact } = await import("@lyrashield/evidence-storage")

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/findings/finding-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("GET /api/findings/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    validateFindingScope.mockResolvedValue({ available: true, target: null, scanId: null })
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

    const response = await GET(
      new Request("http://localhost/api/findings/finding-1?workspaceId=ws-1"),
      {
        params: Promise.resolve({ id: "finding-1" }),
      }
    )
    const body = await response.json()

    const serialized = JSON.stringify(body)
    expect(response.status).toBe(200)
    expect(serialized).not.toContain("storageUri")
    expect(serialized).not.toContain("s3://")
    expect(serialized).not.toContain("evidence-bucket")
    expect(serialized).toContain("result-integrity-v3")
  })

  it("projects producer-shaped claim context without discarding text or CVSS structure", async () => {
    getFinding.mockResolvedValue({
      id: "finding-1",
      title: "Issue",
      severity: "HIGH",
      category: "Application",
      cwe: null,
      recommendedFix: null,
      evidence: [],
    })
    vi.mocked(prisma.evidence.findFirst).mockResolvedValue({
      storageUri: "private://artifact",
    } as never)
    vi.mocked(readEncryptedArtifact).mockResolvedValue({
      content: Buffer.from(
        JSON.stringify({
          counterevidence: "A WAF rule could block exploitation.",
          assumptions: "The endpoint is internet-facing.",
          severityChangeConditions: "Lower if access requires admin role.",
          evidenceWarnings: ["No authenticated coverage"],
          contextualCvssReasoning: "Unauthenticated remote reach.",
          advisoryCvss: {
            score: 8.6,
            vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H",
            source: "engine",
            metric_reasoning: "Network attack vector",
          },
        })
      ),
    } as never)

    const response = await GET(
      new Request("http://localhost/api/findings/finding-1?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    const body = await response.json()

    expect(body.data.evidenceInsights).toMatchObject({
      counterevidence: "A WAF rule could block exploitation.",
      assumptions: "The endpoint is internet-facing.",
      severityChangeConditions: "Lower if access requires admin role.",
      advisoryCvss: {
        score: 8.6,
        vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H",
        metric_reasoning: "Network attack vector",
      },
    })
  })

  it("binds the detail response to the requested observation scope", async () => {
    getFinding.mockResolvedValue({ id: "finding-1", evidence: [] })

    const response = await GET(
      new Request(
        "http://localhost/api/findings/finding-1?workspaceId=ws-1&targetId=target-1&observedInScanId=scan-2"
      ),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(200)
    expect(validateFindingScope).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
    })
    expect(getFinding).toHaveBeenCalledWith("finding-1", "ws-1", {
      targetId: "target-1",
      observedInScanId: "scan-2",
    })
  })

  it("does not return an out-of-scope finding detail", async () => {
    validateFindingScope.mockResolvedValue({ available: false, target: null, scanId: null })

    const response = await GET(
      new Request(
        "http://localhost/api/findings/finding-1?workspaceId=ws-1&observedInScanId=foreign-scan"
      ),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(404)
    expect(getFinding).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/findings/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    getFindingReference.mockResolvedValue({
      id: "finding-1",
      scanId: "scan-1",
      targetId: "target-1",
    })
    acceptRisk.mockResolvedValue({ id: "finding-1", status: "ACCEPTED_RISK" })
    auditLogCreate.mockResolvedValue({})
  })

  it("requires the action-specific permission before accepting risk", async () => {
    const response = await PATCH(
      patchRequest({ workspaceId: "ws-1", action: "accept_risk", reason: "Mitigated" }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "finding:accept_risk")
    expect(getFindingReference).toHaveBeenCalledWith("finding-1", "ws-1")
    expect(acceptRisk).toHaveBeenCalledWith("finding-1", "ws-1", "Mitigated", "user-1")
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        actorUserId: "user-1",
        action: "finding.accept_risk",
        resourceType: "finding",
        resourceId: "finding-1",
      },
    })
  })

  it("does not read or change a finding when the caller lacks its action permission", async () => {
    requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await PATCH(
      patchRequest({ workspaceId: "ws-1", action: "accept_risk", reason: "Mitigated" }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(403)
    expect(getFindingReference).not.toHaveBeenCalled()
    expect(acceptRisk).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it("does not mutate a finding outside the authorized workspace", async () => {
    getFindingReference.mockResolvedValue(null)

    const response = await PATCH(
      patchRequest({ workspaceId: "ws-1", action: "accept_risk", reason: "Mitigated" }),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(404)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "finding:accept_risk")
    expect(getFindingReference).toHaveBeenCalledWith("finding-1", "ws-1")
    expect(acceptRisk).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })
})
