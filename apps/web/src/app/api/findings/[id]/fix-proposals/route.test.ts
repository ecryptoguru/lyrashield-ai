import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  assertOAuthDelegatedScope: vi.fn(),
  getFindingReference: vi.fn(),
  createFixProposal: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: mocks.requirePermission,
  assertOAuthDelegatedScope: mocks.assertOAuthDelegatedScope,
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { fix: { create: "fix:create" } } }))
vi.mock("@lyrashield/db", () => ({
  getFindingReference: mocks.getFindingReference,
  createFixProposal: mocks.createFixProposal,
  prisma: { auditLog: { create: mocks.auditCreate } },
  withDelegatedReadAuthority: async (
    _params: unknown,
    run: (tx: unknown, authority: { targetId: string; allowedProfiles: string[] }) => unknown
  ) => run({}, { targetId: "target-1", allowedProfiles: ["STANDARD"] }),
}))
vi.mock("@lyrashield/integrations", () => ({ enqueueFixGenerate: vi.fn() }))
vi.mock("@/lib/recorded-operation", () => ({
  recordedOperation: async (_request: Request, _input: unknown, operation: () => unknown) =>
    operation(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
vi.mock("@/lib/delegated-target-read-scope", () => ({
  delegatedReadPrincipal: (session: {
    userId?: string
    oauth?: { connectionId?: string; authorizationVersion?: number }
  }) =>
    session.oauth?.connectionId
      ? {
          workspaceId: "workspace-1",
          userId: session.userId ?? "user-1",
          memberId: "member-1",
          memberRole: "OWNER",
          memberUpdatedAt: new Date("2026-11-05T10:00:00Z"),
          connectionId: session.oauth.connectionId,
          authorizationVersion: session.oauth.authorizationVersion ?? 2,
        }
      : null,
  resolveDelegatedTargetReadScope: vi.fn().mockResolvedValue({}),
}))

import { POST } from "./route"

function call() {
  return POST(
    new Request("http://localhost/api/findings/finding-1/fix-proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        summary: "Apply the validated security fix",
        diffRef: "artifact-ref",
      }),
    }),
    { params: Promise.resolve({ id: "finding-1" }) }
  )
}

describe("POST /api/findings/[id]/fix-proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.getFindingReference.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      scan: { mode: "STANDARD" },
    })
    mocks.createFixProposal.mockResolvedValue({ id: "proposal-1" })
    mocks.auditCreate.mockResolvedValue({})
  })

  it("creates a proposal only after target scope is accepted", async () => {
    mocks.assertOAuthDelegatedScope.mockImplementation(() => undefined)

    const response = await call()

    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "fix:create")
    expect(mocks.assertOAuthDelegatedScope).toHaveBeenCalledWith({ userId: "user-1" }, "target-1")
    expect(mocks.createFixProposal).toHaveBeenCalledWith({
      findingId: "finding-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      requireActiveTarget: false,
      summary: "Apply the validated security fix",
      diffRef: "artifact-ref",
    })
  })

  it("denies a delegated connection scoped to another target before creating a proposal", async () => {
    const session = { userId: "agent-1", oauth: { connectionId: "connection-1" } }
    mocks.requirePermission.mockResolvedValue({ session })
    mocks.assertOAuthDelegatedScope.mockImplementation(() => {
      throw new Error("FORBIDDEN")
    })

    const response = await call()

    expect(response.status).toBe(403)
    expect(mocks.assertOAuthDelegatedScope).toHaveBeenCalledWith(session, "target-1")
    expect(mocks.createFixProposal).not.toHaveBeenCalled()
  })

  it("denies callers without fix:create before reading the finding", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    expect((await call()).status).toBe(403)
    expect(mocks.getFindingReference).not.toHaveBeenCalled()
    expect(mocks.createFixProposal).not.toHaveBeenCalled()
  })
})
