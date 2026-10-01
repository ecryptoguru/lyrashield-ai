import { beforeEach, describe, expect, it, vi } from "vitest"

const generateShareToken = vi.fn()
const revokeShareToken = vi.fn()
const getShareableReport = vi.fn()
const getLaunchReportDetail = vi.fn()
const resolveReportDelegationTarget = vi.fn()

vi.mock("@lyrashield/db", () => ({
  generateShareToken: (...args: unknown[]) => generateShareToken(...args),
  revokeShareToken: (...args: unknown[]) => revokeShareToken(...args),
  getShareableReport: (...args: unknown[]) => getShareableReport(...args),
  getLaunchReportDetail: (...args: unknown[]) => getLaunchReportDetail(...args),
  resolveReportDelegationTarget: (...args: unknown[]) => resolveReportDelegationTarget(...args),
}))

// The delegated-scope assertion is a pure function of the session's OAuth
// connection grant: replicated here (same contract as assertOAuthDelegatedScope
// in @lyrashield/auth, which has its own unit tests) so these tests exercise
// real allow/deny decisions rather than a spy that always passes.
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
  requirePermission: vi.fn(),
  assertOAuthDelegatedScope: (...args: unknown[]) =>
    assertOAuthDelegatedScope(args[0] as never, args[1] as never),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, POST } from "./route"
import { requirePermission } from "@lyrashield/auth/server"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

const cookieSession = { userId: "user-1" }
/** Delegated agent connection scoped to target-a only, with report:create granted. */
const narrowSession = {
  userId: "user-1",
  oauth: {
    connectionId: "conn-1",
    workspaceId: "ws-1",
    scopes: ["lyrashield.write"],
    allowedOperations: ["report.create"],
    allowedTargetIds: ["target-a"],
    allTargets: false,
  },
}
const allTargetsSession = {
  userId: "user-1",
  oauth: {
    connectionId: "conn-1",
    workspaceId: "ws-1",
    scopes: ["lyrashield.write"],
    allowedOperations: ["report.create"],
    allowedTargetIds: [],
    allTargets: true,
  },
}

function actionRequest(body: unknown) {
  return new Request("http://localhost/api/reports/report-1", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const postParams = { params: Promise.resolve({ id: "report-1" }) }

describe("POST /api/reports/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: cookieSession } as never)
    getShareableReport.mockResolvedValue({ id: "report-1", status: "generated" })
    resolveReportDelegationTarget.mockResolvedValue({ targetId: "target-a" })
  })

  describe("action: share", () => {
    it("returns the share payload WITHOUT tokenHash", async () => {
      generateShareToken.mockResolvedValue({
        token: "a".repeat(64),
        tokenHash: "b".repeat(64),
        expiresAt: new Date("2026-09-15T00:00:00Z"),
      })

      const response = await POST(
        actionRequest({ workspaceId: "ws-1", action: "share" }),
        postParams
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      // The client has no legitimate use for a hash of the bearer token it already
      // holds — pin the exact key set so the hash cannot silently return.
      expect(Object.keys(body.data).sort()).toEqual(["expiresAt", "shareUrl", "token"])
      expect(body.data.token).toBe("a".repeat(64))
      expect(body.data.shareUrl).toBe(`/reports/shared/report-1?token=${"a".repeat(64)}`)
      expect(JSON.stringify(body)).not.toContain("tokenHash")
    })

    it("404s when the report does not exist in the workspace", async () => {
      resolveReportDelegationTarget.mockResolvedValue(null)

      const response = await POST(
        actionRequest({ workspaceId: "ws-1", action: "share" }),
        postParams
      )

      expect(response.status).toBe(404)
      expect(generateShareToken).not.toHaveBeenCalled()
    })
  })

  describe("action: revoke", () => {
    it("still returns the revocation timestamp", async () => {
      revokeShareToken.mockResolvedValue(new Date("2026-08-16T00:00:00Z"))

      const response = await POST(
        actionRequest({ workspaceId: "ws-1", action: "revoke" }),
        postParams
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: { revoked: true, revokedAt: "2026-08-16T00:00:00.000Z" },
      })
    })
  })

  it("denies sharing or revoking without report:create", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)
    const response = await POST(actionRequest({ workspaceId: "ws-1", action: "share" }), postParams)
    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/reports/[id]",
      "POST"
    )
    expect(resolveReportDelegationTarget).not.toHaveBeenCalled()
    expect(generateShareToken).not.toHaveBeenCalled()
  })

  describe("delegated target scope (W0.3)", () => {
    function shareFor(session: unknown, body: Record<string, unknown> = {}) {
      vi.mocked(requirePermission).mockResolvedValue({ session } as never)
      return POST(actionRequest({ workspaceId: "ws-1", action: "share", ...body }), postParams)
    }

    it("denies share of a target-b report for a grant narrowed to target-a, before any token mutation", async () => {
      resolveReportDelegationTarget.mockResolvedValue({ targetId: "target-b" })

      const response = await shareFor(narrowSession)

      expect(response.status).toBe(403)
      expect(generateShareToken).not.toHaveBeenCalled()
    })

    it("denies revoke of a target-b report for a grant narrowed to target-a, before any mutation", async () => {
      resolveReportDelegationTarget.mockResolvedValue({ targetId: "target-b" })
      vi.mocked(requirePermission).mockResolvedValue({ session: narrowSession } as never)

      const response = await POST(
        actionRequest({ workspaceId: "ws-1", action: "revoke" }),
        postParams
      )

      expect(response.status).toBe(403)
      expect(revokeShareToken).not.toHaveBeenCalled()
    })

    it("allows share when the persisted target matches the grant", async () => {
      resolveReportDelegationTarget.mockResolvedValue({ targetId: "target-a" })
      generateShareToken.mockResolvedValue({
        token: "a".repeat(64),
        tokenHash: "b".repeat(64),
        expiresAt: new Date("2026-09-15T00:00:00Z"),
      })

      const response = await shareFor(narrowSession)

      expect(response.status).toBe(200)
      expect(generateShareToken).toHaveBeenCalledWith("report-1", "ws-1")
    })

    it("allows share for an all-targets grant", async () => {
      resolveReportDelegationTarget.mockResolvedValue({ targetId: "target-b" })
      generateShareToken.mockResolvedValue({
        token: "a".repeat(64),
        tokenHash: "b".repeat(64),
        expiresAt: new Date("2026-09-15T00:00:00Z"),
      })

      const response = await shareFor(allTargetsSession)

      expect(response.status).toBe(200)
      expect(generateShareToken).toHaveBeenCalledOnce()
    })

    it("denies a narrowed grant when the persisted target cannot be resolved (legacy/unbound report)", async () => {
      resolveReportDelegationTarget.mockResolvedValue({ targetId: null })

      const response = await shareFor(narrowSession)

      expect(response.status).toBe(403)
      expect(generateShareToken).not.toHaveBeenCalled()
      expect(revokeShareToken).not.toHaveBeenCalled()
    })

    it("still allows an unresolvable report for an all-targets grant", async () => {
      resolveReportDelegationTarget.mockResolvedValue({ targetId: null })
      revokeShareToken.mockResolvedValue(new Date("2026-08-16T00:00:00Z"))
      vi.mocked(requirePermission).mockResolvedValue({ session: allTargetsSession } as never)

      const response = await POST(
        actionRequest({ workspaceId: "ws-1", action: "revoke" }),
        postParams
      )

      expect(response.status).toBe(200)
      expect(revokeShareToken).toHaveBeenCalledOnce()
    })

    it("ignores a conflicting request-body targetId — the persisted binding is authoritative", async () => {
      // The grant covers target-a but the report is bound to target-b. A caller
      // that could steer the check through the request body would smuggle the
      // share; asserting the persisted binding blocks it.
      resolveReportDelegationTarget.mockResolvedValue({ targetId: "target-b" })

      const response = await shareFor(narrowSession, { targetId: "target-a" })

      expect(response.status).toBe(403)
      expect(generateShareToken).not.toHaveBeenCalled()
    })

    it("denies revoked/expired connections and suspended members at the permission gate, before resolution", async () => {
      vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

      const response = await shareFor(narrowSession)

      expect(response.status).toBe(403)
      expect(resolveReportDelegationTarget).not.toHaveBeenCalled()
      expect(generateShareToken).not.toHaveBeenCalled()
    })
  })
})

describe("GET /api/reports/[id] — authenticated private detail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: cookieSession } as never)
    getShareableReport.mockResolvedValue({ id: "report-1", status: "generated" })
  })

  const PROVENANCE = {
    schemaVersion: "lyrashield-report-provenance/1.0.0",
    gateVerdictId: "verdict-1",
    verdictChecksum: "vc-1",
    assessmentVersion: 2,
    assessedIdentity: { kind: "COMMIT", value: "b".repeat(40) },
    assessedAt: "2026-09-10T00:00:00.000Z",
    issuedAt: "2026-09-10T01:00:00.000Z",
    applicabilityCheckedAt: "2026-09-10T01:00:00.000Z",
    applicability: "applicable",
    reasonCodes: [],
    historicalState: "READY",
    effectiveState: "READY",
  }

  function getRequest() {
    return new Request("http://localhost/api/reports/report-1?workspaceId=ws-1")
  }

  it("includes private launch provenance for launch_readiness reports", async () => {
    getShareableReport.mockResolvedValue({ id: "report-1", type: "launch_readiness" })
    getLaunchReportDetail.mockResolvedValue({
      verdictLabel: "Ready to launch",
      stale: false,
      provenance: PROVENANCE,
    })

    const response = await GET(getRequest(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.launchReport.provenance.gateVerdictId).toBe("verdict-1")
    expect(body.data.launchReport.provenance.assessedIdentity.value).toBe("b".repeat(40))
    expect(getLaunchReportDetail).toHaveBeenCalledWith("report-1", "ws-1")
  })

  it("omits launch provenance for other report types", async () => {
    getShareableReport.mockResolvedValue({ id: "report-1", type: "developer" })

    const response = await GET(getRequest(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.launchReport).toBeUndefined()
    expect(getLaunchReportDetail).not.toHaveBeenCalled()
  })

  it("denies private report reads without report:download", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const response = await GET(getRequest(), { params: Promise.resolve({ id: "report-1" }) })

    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/reports/[id]",
      "GET"
    )
    expect(getShareableReport).not.toHaveBeenCalled()
  })

  it("returns an ETag on 200 and a bodyless 304 for a matching If-None-Match (W2.4)", async () => {
    getShareableReport.mockResolvedValue({ id: "report-1", type: "developer" })

    const first = await GET(getRequest(), { params: Promise.resolve({ id: "report-1" }) })
    expect(first.status).toBe(200)
    const etag = first.headers.get("ETag")
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)

    const conditional = new Request("http://localhost/api/reports/report-1?workspaceId=ws-1", {
      headers: { "If-None-Match": etag! },
    })
    const second = await GET(conditional, { params: Promise.resolve({ id: "report-1" }) })
    expect(second.status).toBe(304)
    expect(second.headers.get("ETag")).toBe(etag)
    expect(await second.text()).toBe("")
  })
})
