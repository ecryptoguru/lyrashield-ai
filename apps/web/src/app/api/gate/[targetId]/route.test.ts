import { beforeEach, describe, expect, it, vi } from "vitest"

const getCurrentGateVerdict = vi.fn()
const evaluateGateForTarget = vi.fn()
const requirePermission = vi.fn()

vi.mock("@lyrashield/db", () => ({
  getCurrentGateVerdict,
  evaluateGateForTarget,
}))

// Same pure contract as assertOAuthDelegatedScope in @lyrashield/auth —
// replicated so these tests exercise real allow/deny decisions for narrowed
// delegated grants.
function delegatedScopeCheck(
  session: { oauth?: { connectionId?: string; allTargets?: boolean; allowedTargetIds?: string[] } },
  targetId: string | null | undefined
) {
  const connection = session?.oauth
  if (!connection?.connectionId) return
  if (!targetId && !connection.allTargets) throw new Error("FORBIDDEN")
  if (targetId && !connection.allTargets && !connection.allowedTargetIds?.includes(targetId)) {
    throw new Error("FORBIDDEN")
  }
}
const assertOAuthDelegatedScope = vi.fn(delegatedScopeCheck)
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission,
  assertOAuthDelegatedScope: (...args: unknown[]) =>
    assertOAuthDelegatedScope(args[0] as never, args[1] as never),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { finding: { view: "finding:view" }, scan: { create: "scan:create" } },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

const { GET, POST } = await import("./route")

const cookieSession = { userId: "user-1" }
const narrowSession = {
  userId: "user-1",
  oauth: {
    connectionId: "conn-1",
    workspaceId: "ws-1",
    scopes: ["lyrashield.read", "lyrashield.write"],
    allowedOperations: ["scan.create"],
    allowedTargetIds: ["target-a"],
    allTargets: false,
  },
}

describe("GET /api/gate/[targetId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: cookieSession })
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

  it("denies a narrowed delegated grant reading another target's verdict (W0.3)", async () => {
    requirePermission.mockResolvedValue({ session: narrowSession })

    const response = await GET(
      new Request("http://localhost/api/gate/target-b?workspaceId=ws-1"),
      { params: Promise.resolve({ targetId: "target-b" }) }
    )

    expect(response.status).toBe(403)
    expect(getCurrentGateVerdict).not.toHaveBeenCalled()
  })
})

describe("POST /api/gate/[targetId] delegated scope (W0.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: cookieSession })
  })

  function postRequest(targetId: string) {
    return POST(new Request(`http://localhost/api/gate/${targetId}?workspaceId=ws-1`, { method: "POST" }), {
      params: Promise.resolve({ targetId }),
    })
  }

  it("denies evaluation for a target outside a narrowed grant, before evaluation", async () => {
    requirePermission.mockResolvedValue({ session: narrowSession })

    const response = await postRequest("target-b")

    expect(response.status).toBe(403)
    expect(evaluateGateForTarget).not.toHaveBeenCalled()
  })

  it("admits evaluation inside the grant", async () => {
    requirePermission.mockResolvedValue({ session: narrowSession })
    evaluateGateForTarget.mockResolvedValue({ state: "READY" })

    const response = await postRequest("target-a")

    expect(response.status).toBe(201)
    expect(evaluateGateForTarget).toHaveBeenCalledWith("ws-1", "target-a")
  })

  it("admits a permitted cookie session", async () => {
    evaluateGateForTarget.mockResolvedValue({ state: "READY" })

    const response = await postRequest("target-b")

    expect(response.status).toBe(201)
  })
})
