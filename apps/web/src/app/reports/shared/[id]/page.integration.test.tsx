import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  reportFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  updateMany: vi.fn(),
  scanFindFirst: vi.fn(),
  groupBy: vi.fn(),
  tokenFindFirst: vi.fn(),
  requirePermission: vi.fn(),
  principal: vi.fn(),
  withAuthority: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("../../../../../../../packages/db/src/client", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    report: { findFirst: mocks.reportFindFirst, updateMany: mocks.updateMany },
    scan: { findFirst: mocks.scanFindFirst },
    finding: { groupBy: mocks.groupBy },
  },
}))
vi.mock("../../../../../../../packages/db/src/rls", () => ({
  withWorkspaceRLS: async (_workspaceId: string, read: (tx: unknown) => unknown) =>
    read((await import("../../../../../../../packages/db/src/client")).prisma),
}))
vi.mock("../../../../../../../packages/db/src/system-client", () => ({
  getSystemPrisma: () => ({ report: { findFirst: mocks.tokenFindFirst } }),
}))
// Exercise the real generic services through the page and routes. Only DB IO,
// the separate launch renderer, and request authentication are fixture ports.
vi.mock("@lyrashield/db", async () => ({
  ...(await import("../../../../../../../packages/db/src/report-service")),
  getSharedLaunchReport: vi.fn().mockResolvedValue(null),
  getLaunchReportDetail: vi.fn(),
  withDelegatedReadAuthority: mocks.withAuthority,
}))
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: mocks.requirePermission,
  assertOAuthDelegatedScope: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("../../../../lib/api-auth", () => ({
  withCookieMutation: (handler: unknown) => handler,
  authErrorResponse: (error: Error) =>
    error.message === "FORBIDDEN"
      ? Response.json({ success: false, error: { code: "FORBIDDEN" } }, { status: 403 })
      : null,
  getApiRequestId: () => undefined,
}))
vi.mock("../../../../lib/delegated-target-read-scope", () => ({
  delegatedReadPrincipal: mocks.principal,
}))
vi.mock("./shared-report-view", () => ({
  SharedReportView: () => null,
}))
vi.mock("./launch-report-view", () => ({
  SharedLaunchReportView: () => null,
}))

import SharedReportPage from "./page"
import { GET as sharedGet } from "../../../api/reports/shared/[id]/route"
import { GET as reportGet, POST as reportPost } from "../../../api/reports/[id]/route"
import { POST as packetPost } from "../../../api/reports/release-packet/[id]/route"
import { getReportByShareToken } from "../../../../../../../packages/db/src/report-service"

// Synthetic capability, deliberately unrelated to any deployed report.
const token = "a".repeat(64)
const params = { params: Promise.resolve({ id: "packet-fixture" }) }
const report = {
  id: "packet-fixture",
  workspaceId: "workspace-fixture",
  type: "release_packet",
  scanId: "scan-fixture",
  contentJson: { version: "release_packet/1.1.0" },
  shareTokenHash: createHash("sha256").update(token).digest("hex"),
  shareExpiresAt: new Date("2030-01-01T00:00:00Z"),
  revokedAt: null as Date | null,
  deletedAt: null,
}

describe("release packet cannot cross the generic report boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    report.type = "release_packet"
    report.revokedAt = null
    report.shareTokenHash = createHash("sha256").update(token).digest("hex")
    mocks.principal.mockReturnValue(null)
    mocks.withAuthority.mockImplementation(async (_principal, run) =>
      run((await import("../../../../../../../packages/db/src/client")).prisma, {
        targetIds: ["target-fixture"],
        allowedProfiles: ["STANDARD"],
      })
    )
    mocks.reportFindFirst.mockResolvedValue(report)
    mocks.queryRaw.mockImplementation(async (_sql, id, workspaceId, hash) =>
      id === report.id &&
      workspaceId === report.workspaceId &&
      hash === report.shareTokenHash &&
      !report.revokedAt
        ? [report]
        : []
    )
    mocks.tokenFindFirst.mockImplementation(async ({ where }) =>
      where.shareTokenHash === report.shareTokenHash && report.revokedAt === null
        ? { id: report.id, workspaceId: report.workspaceId, shareExpiresAt: report.shareExpiresAt }
        : null
    )
    mocks.scanFindFirst.mockResolvedValue({
      id: report.scanId,
      targetId: "target-fixture",
      status: "COMPLETED",
      summary: "Private scan summary must never render",
    })
    mocks.groupBy.mockResolvedValue([])
    mocks.requirePermission.mockResolvedValue({ session: { userId: "member-fixture" } })
    mocks.updateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.workspaceId !== report.workspaceId ||
        where.id !== report.id ||
        (typeof where.type === "string"
          ? where.type !== report.type
          : where.type?.not === report.type)
      )
        return { count: 0 }
      if (
        where.scan &&
        (!where.scan.targetId.in.includes("target-fixture") ||
          !where.scan.mode.in.includes("STANDARD"))
      )
        return { count: 0 }
      Object.assign(report, data)
      return { count: 1 }
    })
  })

  it("404s a valid packet token on the generic page without any membership or summary read", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
    await expect(getReportByShareToken(token)).resolves.toMatchObject({ id: report.id })
    await expect(
      SharedReportPage({ ...params, searchParams: Promise.resolve({ token }) })
    ).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.requirePermission).not.toHaveBeenCalled()
    expect(mocks.scanFindFirst).not.toHaveBeenCalled()
    expect(mocks.groupBy).not.toHaveBeenCalled()
  })

  it("denies the generic page when a token is revoked after lookup", async () => {
    report.type = "developer"
    mocks.queryRaw.mockResolvedValue([])
    await expect(
      SharedReportPage({ ...params, searchParams: Promise.resolve({ token }) })
    ).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.scanFindFirst).not.toHaveBeenCalled()
    expect(mocks.groupBy).not.toHaveBeenCalled()
  })

  it("denies the generic API when a token is revoked after lookup", async () => {
    report.type = "developer"
    mocks.queryRaw.mockResolvedValue([])
    const response = await sharedGet(
      new Request(`http://localhost/api/reports/shared/${report.id}?token=${token}`),
      params
    )
    expect(response.status).toBe(404)
    expect(mocks.scanFindFirst).not.toHaveBeenCalled()
    expect(mocks.groupBy).not.toHaveBeenCalled()
  })

  it("404s the same valid token on the generic shared API before a summary read", async () => {
    const response = await sharedGet(
      new Request(`http://localhost/api/reports/shared/${report.id}?token=${token}`),
      params
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain("Private scan summary")
    expect(mocks.requirePermission).not.toHaveBeenCalled()
    expect(mocks.scanFindFirst).not.toHaveBeenCalled()
    expect(mocks.groupBy).not.toHaveBeenCalled()
  })

  it("also rejects the authenticated generic report API", async () => {
    const response = await reportGet(
      new Request(`http://localhost/api/reports/${report.id}?workspaceId=${report.workspaceId}`),
      params
    )
    expect(response.status).toBe(404)
    expect(mocks.scanFindFirst).not.toHaveBeenCalled()
    expect(mocks.groupBy).not.toHaveBeenCalled()
  })

  it.each(["share", "revoke"])(
    "cannot %s a packet token through the generic mutation API",
    async (action) => {
      const original = { ...report }
      const response = await reportPost(
        new Request(`http://localhost/api/reports/${report.id}`, {
          method: "POST",
          body: JSON.stringify({ workspaceId: report.workspaceId, action }),
        }),
        params
      )
      expect(response.status).toBe(404)
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: {
          id: report.id,
          workspaceId: report.workspaceId,
          deletedAt: null,
          type: { not: "release_packet" },
        },
        data: expect.any(Object),
      })
      expect(report).toEqual(original)
      expect(await response.text()).not.toContain("shareUrl")
    }
  )

  it("preserves normal report summaries on the generic page and shared API", async () => {
    report.type = "developer"
    const page = await SharedReportPage({ ...params, searchParams: Promise.resolve({ token }) })
    expect(page.props.report.scanSummary.summary).toBe("Private scan summary must never render")
    const response = await sharedGet(
      new Request(`http://localhost/api/reports/shared/${report.id}?token=${token}`),
      params
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Private scan summary must never render")
  })

  function packetRequest(action: "share" | "revoke", workspaceId = report.workspaceId) {
    return new Request(`http://localhost/api/reports/release-packet/${report.id}`, {
      method: "POST",
      body: JSON.stringify({ workspaceId, action }),
    })
  }

  it("revokes a private packet capability through the authorized packet API", async () => {
    const originalHash = report.shareTokenHash
    const response = await packetPost(packetRequest("revoke"), params)
    expect(response.status).toBe(200)
    expect(report.shareTokenHash).toBe(originalHash)
    expect(report.revokedAt).toBeInstanceOf(Date)
    await expect(getReportByShareToken(token)).resolves.toBeNull()
  })

  it("creates a packet link and a repeated browser share request rotates the prior token", async () => {
    report.shareTokenHash = ""
    const created = await packetPost(packetRequest("share"), params)
    const first = (await created.json()).data
    expect(created.status).toBe(200)
    expect(first.shareUrl).toMatch(/^\/reports\/release-packet\/shared\/packet-fixture\?token=/)
    await expect(getReportByShareToken(first.token)).resolves.toMatchObject({ id: report.id })
    const rotated = await packetPost(packetRequest("share"), params)
    const second = (await rotated.json()).data
    expect(rotated.status).toBe(200)
    expect(second.token).not.toBe(first.token)
    await expect(getReportByShareToken(first.token)).resolves.toBeNull()
    await expect(getReportByShareToken(second.token)).resolves.toMatchObject({ id: report.id })
    await expect(
      SharedReportPage({ ...params, searchParams: Promise.resolve({ token: second.token }) })
    ).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it.each(["share", "revoke"] as const)(
    "preserves the packet token on cross-workspace %s",
    async (action) => {
      const original = { ...report }
      expect((await packetPost(packetRequest(action, "other-workspace"), params)).status).toBe(404)
      expect(report).toEqual(original)
    }
  )

  it.each(["share", "revoke"] as const)(
    "preserves the packet token on unauthorized %s",
    async (action) => {
      const original = { ...report }
      mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
      expect((await packetPost(packetRequest(action), params)).status).toBe(403)
      expect(report).toEqual(original)
      expect(mocks.updateMany).not.toHaveBeenCalled()
    }
  )

  it.each(["share", "revoke"] as const)(
    "denies OAuth %s and retries without changing the packet token",
    async (action) => {
      const original = { ...report }
      mocks.requirePermission.mockResolvedValue({
        session: {
          userId: "oauth-fixture",
          oauth: {
            connectionId: "connection-fixture",
            authorizationVersion: 4,
            workspaceId: report.workspaceId,
            scopes: ["lyrashield.write"],
            allowedOperations: ["report.create"],
          },
        },
      })
      for (let retry = 0; retry < 2; retry++) {
        expect((await packetPost(packetRequest(action), params)).status).toBe(403)
      }
      expect(report).toEqual(original)
      expect(mocks.updateMany).not.toHaveBeenCalled()
      expect(mocks.withAuthority).not.toHaveBeenCalled()
    }
  )
})
