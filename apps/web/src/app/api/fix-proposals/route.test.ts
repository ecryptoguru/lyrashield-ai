import { resolveOAuthReadScope } from "../../../../../../packages/auth/src/oauth-read-scope"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listFixProposals: vi.fn(),
  validateFindingScope: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  listFixProposals: mocks.listFixProposals,
  validateFindingScope: mocks.validateFindingScope,
  withDelegatedReadAuthority: async (
    params: {
      targetId?: string
      allTargets?: boolean
      allowedTargetIds?: string[]
    },
    run: (
      tx: unknown,
      authority: { targetId?: string; targetIds?: string[]; allowedProfiles: string[] }
    ) => unknown
  ) => {
    if (
      params.targetId &&
      !params.allTargets &&
      !params.allowedTargetIds?.includes(params.targetId)
    ) {
      throw new Error("FORBIDDEN")
    }
    return run(
      {},
      {
        ...(params.targetId
          ? { targetId: params.targetId }
          : { targetIds: params.allowedTargetIds ?? [] }),
        allowedProfiles: ["SAFE", "STANDARD", "QUICK"],
      }
    )
  },
}))
vi.mock("@lyrashield/auth/server", () => ({
  resolveOAuthReadScope,
  requirePermission: mocks.requirePermission,
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))
vi.mock("../../../lib/delegated-target-read-scope", () => ({
  delegatedReadPrincipal: (session: {
    userId?: string
    oauth?: {
      connectionId?: string
      allTargets?: boolean
      allowedTargetIds?: string[]
    }
  }) =>
    session.oauth?.connectionId
      ? {
          workspaceId: "ws-1",
          userId: session.userId ?? "user-1",
          memberId: "member-1",
          memberRole: "OWNER",
          memberUpdatedAt: new Date("2026-11-05T10:00:00Z"),
          connectionId: session.oauth.connectionId,
          authorizationVersion: 2,
          allTargets: session.oauth.allTargets,
          allowedTargetIds: session.oauth.allowedTargetIds ?? [],
        }
      : null,
}))

import { GET } from "./route"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

describe("GET /api/fix-proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.validateFindingScope.mockResolvedValue({ available: true, target: null, scanId: null })
    mocks.listFixProposals.mockResolvedValue({ items: [], nextCursor: null })
  })

  it("passes the observed scan and target scope through to the shared query", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/fix-proposals?workspaceId=ws-1&targetId=target-1&observedInScanId=scan-2&cursor=proposal-1"
      )
    )

    expect(response.status).toBe(200)
    expect(mocks.validateFindingScope).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
    })
    expect(mocks.listFixProposals).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
      cursor: "proposal-1",
      limit: 50,
    })
  })

  it("returns patch availability without disclosing storage references", async () => {
    mocks.listFixProposals.mockResolvedValue({
      items: [
        {
          id: "stored",
          diffRef: "s3://private/patch",
          finding: { id: "f-1", baseCommit: "a".repeat(40) },
        },
        { id: "summary", diffRef: null, finding: { id: "f-2", baseCommit: null } },
      ],
      nextCursor: null,
    })
    const response = await GET(new Request("http://localhost/api/fix-proposals?workspaceId=ws-1"))
    const body = await response.json()
    expect(body.data.items).toEqual([
      {
        id: "stored",
        finding: { id: "f-1", baseCommit: "a".repeat(40) },
        hasStoredPatch: true,
        hasPatchBase: true,
      },
      {
        id: "summary",
        finding: { id: "f-2", baseCommit: null },
        hasStoredPatch: false,
        hasPatchBase: false,
      },
    ])
  })

  it("keeps a paginated proposal's pull-request action usable", async () => {
    // Regression: the second page bypasses the server-rendered page, so the
    // API must carry the derived base-commit flag itself.
    mocks.listFixProposals.mockResolvedValue({
      items: [
        {
          id: "page-2",
          status: "ready",
          diffRef: "s3://private/patch",
          finding: { id: "f-1", baseCommit: "b".repeat(40) },
        },
      ],
      nextCursor: null,
    })
    const response = await GET(
      new Request("http://localhost/api/fix-proposals?workspaceId=ws-1&cursor=page-1")
    )
    const body = await response.json()
    expect(body.data.items[0]).toMatchObject({
      id: "page-2",
      hasStoredPatch: true,
      hasPatchBase: true,
    })
    expect(body.data.items[0]).not.toHaveProperty("diffRef")
  })

  it("marks a proposal whose scan recorded no base commit", async () => {
    mocks.listFixProposals.mockResolvedValue({
      items: [{ id: "no-base", diffRef: "s3://private/patch", finding: { id: "f-1" } }],
      nextCursor: null,
    })
    const response = await GET(new Request("http://localhost/api/fix-proposals?workspaceId=ws-1"))
    const body = await response.json()
    expect(body.data.items[0]).toMatchObject({ hasStoredPatch: true, hasPatchBase: false })
  })

  it("rejects an unavailable scope before listing fixes", async () => {
    mocks.validateFindingScope.mockResolvedValue({ available: false, target: null, scanId: null })

    const response = await GET(
      new Request(
        "http://localhost/api/fix-proposals?workspaceId=ws-1&observedInScanId=foreign-scan"
      )
    )

    expect(response.status).toBe(400)
    expect(mocks.listFixProposals).not.toHaveBeenCalled()
  })

  it("denies fix-proposal reads without finding:view", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))
    const response = await GET(new Request("http://localhost/api/fix-proposals?workspaceId=ws-1"))
    expectPermissionDenied(
      response,
      mocks.requirePermission.mock.calls,
      "ws-1",
      "/api/fix-proposals",
      "GET"
    )
    expect(mocks.listFixProposals).not.toHaveBeenCalled()
  })
})

describe("OAuth proposal read scope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: {
          connectionId: "conn-1",
          allTargets: false,
          allowedTargetIds: ["target-1"],
        },
      },
    })
    mocks.validateFindingScope.mockResolvedValue({ available: true, target: null, scanId: null })
    mocks.listFixProposals.mockResolvedValue({ items: [], nextCursor: null })
  })

  it("rejects an explicit target outside the grant", async () => {
    const response = await GET(
      new Request("http://localhost/api/fix-proposals?workspaceId=ws-1&targetId=target-2")
    )
    expect(response.status).toBe(403)
    expect(mocks.listFixProposals).not.toHaveBeenCalled()
  })

  it("intersects finding and pagination filters with the granted target IDs", async () => {
    await GET(
      new Request(
        "http://localhost/api/fix-proposals?workspaceId=ws-1&findingId=finding-2&cursor=proposal-1"
      )
    )
    expect(mocks.listFixProposals).toHaveBeenCalledWith(
      expect.objectContaining({
        targetIds: ["target-1"],
        findingId: "finding-2",
        cursor: "proposal-1",
      }),
      expect.any(Object)
    )
  })
})
