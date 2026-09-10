import { beforeEach, describe, expect, it, vi } from "vitest"

const getCurrentGateVerdict = vi.fn()
const requirePermission = vi.fn()

vi.mock("@lyrashield/db", () => ({
  getCurrentGateVerdict,
  evaluateGateForTarget: vi.fn(),
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

const { GET } = await import("./route")

describe("GET /api/gate/[targetId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue(undefined)
  })

  it("returns the effective fail-closed state separately from historical verdict history", async () => {
    getCurrentGateVerdict.mockResolvedValue({
      schemaVersion: "lyrashield-gate-response/2.0.0",
      state: "INSUFFICIENT_EVIDENCE",
      applicability: {
        applicable: false,
        reasons: [{ code: "EXPECTED_IDENTITY_REQUIRED" }],
      },
      historical: { state: "READY", inputChecksum: "historical-input" },
    })

    const response = await GET(new Request("http://localhost/api/gate/target-1?workspaceId=ws-1"), {
      params: Promise.resolve({ targetId: "target-1" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        state: "INSUFFICIENT_EVIDENCE",
        applicability: { applicable: false },
        historical: { state: "READY", inputChecksum: "historical-input" },
      },
    })
    expect(getCurrentGateVerdict).toHaveBeenCalledWith("ws-1", "target-1", {
      expectedCommit: undefined,
      expectedArtifactDigest: undefined,
    })
  })

  it("rejects mutually exclusive release identities", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/gate/target-1?workspaceId=ws-1&commit=${"a".repeat(40)}&artifactDigest=sha256:${"b".repeat(64)}`
      ),
      { params: Promise.resolve({ targetId: "target-1" }) }
    )

    expect(response.status).toBe(400)
    expect(getCurrentGateVerdict).not.toHaveBeenCalled()
  })
})
