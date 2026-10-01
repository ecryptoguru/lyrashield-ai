import { beforeEach, describe, expect, it, vi } from "vitest"

const generateLaunchReport = vi.fn()
const generateShareToken = vi.fn()
const resolveLaunchReportSigningPrivateKey = vi.fn()

vi.mock("@lyrashield/db", () => ({
  generateLaunchReport: (...args: unknown[]) => generateLaunchReport(...args),
  generateShareToken: (...args: unknown[]) => generateShareToken(...args),
}))
vi.mock("@lyrashield/billing", () => ({
  resolveLaunchReportSigningPrivateKey: (...args: unknown[]) =>
    resolveLaunchReportSigningPrivateKey(...args),
}))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
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
  requirePermission: vi.fn(),
  assertOAuthDelegatedScope: (...args: unknown[]) =>
    assertOAuthDelegatedScope(args[0] as never, args[1] as never),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { POST } from "./route"
import { requirePermission } from "@lyrashield/auth/server"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

const cookieSession = { userId: "user-1" }
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
  oauth: { ...narrowSession.oauth, allowedTargetIds: [], allTargets: true },
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/reports/launch-readiness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

const GENERATED = {
  reportId: "report-1",
  payload: { verdictLabel: "Ready to launch", signature: "sig", stale: false },
}

describe("POST /api/reports/launch-readiness delegated target scope (W0.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: cookieSession } as never)
    resolveLaunchReportSigningPrivateKey.mockResolvedValue("private-key")
    generateLaunchReport.mockResolvedValue(GENERATED)
    generateShareToken.mockResolvedValue({
      token: "a".repeat(64),
      tokenHash: "b".repeat(64),
      expiresAt: new Date("2026-09-15T00:00:00Z"),
    })
  })

  it("denies generation for a target outside a narrowed grant — before key resolution, generation or share token", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: narrowSession } as never)

    const response = await post({ workspaceId: "ws-1", targetId: "target-b" })

    expect(response.status).toBe(403)
    expect(resolveLaunchReportSigningPrivateKey).not.toHaveBeenCalled()
    expect(generateLaunchReport).not.toHaveBeenCalled()
    expect(generateShareToken).not.toHaveBeenCalled()
  })

  it("denies share:true for an out-of-scope target with no token minted", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: narrowSession } as never)

    const response = await post({ workspaceId: "ws-1", targetId: "target-b", share: true })

    expect(response.status).toBe(403)
    expect(generateLaunchReport).not.toHaveBeenCalled()
    expect(generateShareToken).not.toHaveBeenCalled()
  })

  it("asserts the request targetId, not a substituted one, for narrowed grants", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: narrowSession } as never)

    const response = await post({ workspaceId: "ws-1", targetId: "target-a" })

    expect(response.status).toBe(201)
    expect(generateLaunchReport).toHaveBeenCalledWith(
      "ws-1",
      "target-a",
      "user-1",
      expect.objectContaining({ signingPrivateKey: "private-key" })
    )
  })

  it("allows an all-targets grant", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ session: allTargetsSession } as never)

    const response = await post({ workspaceId: "ws-1", targetId: "target-b" })

    expect(response.status).toBe(201)
    expect(generateLaunchReport).toHaveBeenCalledOnce()
  })

  it("allows a permitted cookie session", async () => {
    const response = await post({ workspaceId: "ws-1", targetId: "target-b", share: true })

    expect(response.status).toBe(201)
    expect(generateShareToken).toHaveBeenCalledWith("report-1", "ws-1")
  })

  it("denies before side effects when the permission gate itself fails", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const response = await post({ workspaceId: "ws-1", targetId: "target-a" })

    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/reports/launch-readiness",
      "POST"
    )
    expect(resolveLaunchReportSigningPrivateKey).not.toHaveBeenCalled()
    expect(generateLaunchReport).not.toHaveBeenCalled()
    expect(generateShareToken).not.toHaveBeenCalled()
  })
})
