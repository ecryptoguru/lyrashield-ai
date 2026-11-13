import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findFirst: vi.fn(),
  execute: vi.fn(),
  scoped: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: { auditLog: { create: mocks.create }, $executeRaw: mocks.execute },
  withWorkspaceRLS: mocks.scoped,
}))

const { deliverOnboardingWorkspaceAudit } = await import("./onboarding-workspace-audit")

const workspaceId = "workspace-created-1"
const userId = "user-1"
const audit = {
  id: workspaceId,
  workspaceId,
  actorUserId: userId,
  action: "workspace.created",
  resourceType: "workspace",
  resourceId: workspaceId,
}

describe("onboarding workspace creation audit delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.execute.mockResolvedValue(1)
    mocks.scoped.mockImplementation(async (_workspaceId, fn) =>
      fn({ auditLog: { findFirst: mocks.findFirst } })
    )
  })

  it("writes one deterministic audit and clears the pending marker", async () => {
    mocks.create.mockResolvedValue(audit)
    await deliverOnboardingWorkspaceAudit(userId, workspaceId)
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ data: audit })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledOnce()
  })

  it("confirms a committed audit when its create response is lost", async () => {
    mocks.create.mockRejectedValueOnce(new Error("connection lost after commit"))
    mocks.findFirst.mockResolvedValueOnce(audit)
    await deliverOnboardingWorkspaceAudit(userId, workspaceId)
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.scoped).toHaveBeenCalledWith(workspaceId, expect.any(Function))
    expect(mocks.execute).toHaveBeenCalledOnce()
  })

  it("retries once when the first failure produced no audit", async () => {
    mocks.create.mockRejectedValueOnce(new Error("before commit")).mockResolvedValueOnce(audit)
    mocks.findFirst.mockResolvedValueOnce(null)
    await deliverOnboardingWorkspaceAudit(userId, workspaceId)
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.execute).toHaveBeenCalledOnce()
  })

  it("keeps the marker after bounded failed attempts", async () => {
    mocks.create.mockRejectedValue(new Error("audit unavailable"))
    mocks.findFirst.mockResolvedValue(null)
    await expect(deliverOnboardingWorkspaceAudit(userId, workspaceId)).rejects.toThrow(
      "audit unavailable"
    )
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it("does not clear the marker for a conflicting audit identity", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" })
    mocks.findFirst.mockResolvedValue({ ...audit, actorUserId: "other-user" })
    await expect(deliverOnboardingWorkspaceAudit(userId, workspaceId)).rejects.toThrow(
      "audit identity differs"
    )
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it("concurrent deliveries retain one original audit", async () => {
    let committed = false
    mocks.create.mockImplementation(async () => {
      if (committed) throw Object.assign(new Error("duplicate"), { code: "P2002" })
      committed = true
      return audit
    })
    mocks.findFirst.mockResolvedValue(audit)
    await Promise.all([
      deliverOnboardingWorkspaceAudit(userId, workspaceId),
      deliverOnboardingWorkspaceAudit(userId, workspaceId),
    ])
    expect(committed).toBe(true)
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
  })
})
