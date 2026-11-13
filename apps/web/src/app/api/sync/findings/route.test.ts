import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requirePermission: vi.fn(),
  resolveSyncCredential: vi.fn(),
  rls: vi.fn(),
  revalidate: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requireAuth: mocks.requireAuth,
  requirePermission: mocks.requirePermission,
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {},
  withWorkspaceRLS: mocks.rls,
}))
vi.mock("../../../../lib/cache", () => ({
  revalidateDashboardAggregates: mocks.revalidate,
}))
vi.mock("@lyrashield/config", () => ({
  env: { LYRASHIELD_SYNC_MAX_FINDINGS_PER_BATCH: 100 },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("../../../../lib/sync-license-auth", () => ({
  markLegacySyncResponse: (response: Response) => response,
  resolveSyncCredential: mocks.resolveSyncCredential,
}))

import { POST } from "./route"

const session = {
  userId: "user-1",
  userEmail: "user@example.com",
  userName: "User",
  userImage: null,
  sessionId: "session-1",
}

async function submit(
  body: Record<string, unknown> = { workspaceId: "workspace-1", findings: [] }
) {
  return POST(
    new Request("https://app.example.com/api/sync/findings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("POST /api/sync/findings workspace authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(session)
    mocks.requirePermission.mockResolvedValue({ workspace: { role: "OWNER" } })
    mocks.resolveSyncCredential.mockResolvedValue({
      ok: false,
      code: "SYNC_NOT_CONNECTED",
      message: "Sync has not been established",
      status: 409,
    })
  })

  it("requires finding:update and allows a workspace writer through permission checks", async () => {
    const response = await submit()

    expect(response.status).toBe(409)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "finding:update")
    expect(mocks.resolveSyncCredential).toHaveBeenCalledOnce()
  })

  it("denies a Viewer even though the shared permission overlay includes operational permissions", async () => {
    mocks.requirePermission.mockResolvedValue({ workspace: { role: "VIEWER" } })

    const response = await submit()

    expect(response.status).toBe(403)
    expect(mocks.resolveSyncCredential).not.toHaveBeenCalled()
  })

  it.each(["suspended membership"])("denies a %s", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await submit()

    expect(response.status).toBe(403)
    expect(mocks.resolveSyncCredential).not.toHaveBeenCalled()
  })

  it("invalidates the dashboard after committed findings or reports, but not an empty batch", async () => {
    mocks.resolveSyncCredential.mockResolvedValue({
      ok: true,
      license: { id: "license-1" },
      legacyLicenseKey: false,
    })
    const cursor = {
      id: "cursor-1",
      seq: 0n,
      lastSyncedAt: new Date("2026-09-28T00:00:00Z"),
      lastSyncedFindingId: null,
    }
    const tx = {
      syncCursor: {
        findUnique: vi.fn().mockResolvedValue(cursor),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      scan: { findFirst: vi.fn().mockResolvedValue({ id: "scan-1" }) },
      finding: { upsert: vi.fn() },
      report: { create: vi.fn() },
    }
    mocks.rls.mockImplementation(async (_workspaceId, fn) => fn(tx))

    const synced = await submit({
      workspaceId: "workspace-1",
      expectedSeq: 0,
      findings: [
        {
          id: "finding-1",
          severity: "HIGH",
          title: "Detection",
          status: "OPEN",
          verified: false,
          detectedAt: "2026-09-28T00:00:00Z",
        },
      ],
    })
    expect(synced.status).toBe(200)
    expect(tx.finding.upsert).toHaveBeenCalledOnce()
    expect(mocks.revalidate).toHaveBeenCalledOnce()
    expect(mocks.revalidate).toHaveBeenCalledWith("workspace-1")

    mocks.revalidate.mockClear()
    const report = await submit({
      workspaceId: "workspace-1",
      reports: [
        {
          id: "report-1",
          name: "Local report",
          content: "{}",
          createdAt: "2026-09-28T00:00:00Z",
        },
      ],
      findings: [],
    })
    expect(report.status).toBe(200)
    expect(tx.report.create).toHaveBeenCalledOnce()
    expect(mocks.revalidate).toHaveBeenCalledWith("workspace-1")

    mocks.revalidate.mockClear()
    const empty = await submit()
    expect(empty.status).toBe(200)
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })
})
