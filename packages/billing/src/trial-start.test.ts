import { beforeEach, describe, expect, it, vi } from "vitest"

const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const workspaceUpdateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ count: 1 }))
const billingUpsertMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "billing_1" }))
const usageCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "usage_1" }))
const membershipFindManyMock = vi.hoisted(() => vi.fn())
const workspaceFindFirstMock = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/db", () => ({
  prisma: {},
  withWorkspaceRLS: withWorkspaceRLSMock,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({ CLOUD_PLAN_MAP: { TRIAL: { targetCaps: 3 } } }))

import { startTrial, TRIAL_AGENT_MINUTES } from "./trial"

beforeEach(() => {
  vi.clearAllMocks()
  const tx = {
    $executeRaw: executeRawMock,
    workspaceMember: {
      findMany: membershipFindManyMock,
    },
    workspace: {
      findFirst: workspaceFindFirstMock,
      updateMany: workspaceUpdateMock,
    },
    billingAccount: { upsert: billingUpsertMock },
    usageRecord: { create: usageCreateMock },
  }
  membershipFindManyMock.mockResolvedValue([{ workspaceId: "ws_1" }])
  workspaceFindFirstMock.mockResolvedValue(null)
  withWorkspaceRLSMock.mockImplementation((workspaceId, callback) => {
    expect(workspaceId).toBe("ws_1")
    return callback(tx)
  })
})

describe("startTrial", () => {
  it("serializes a user trial and atomically creates its entitlement", async () => {
    const result = await startTrial("ws_1", "user_1")

    expect(executeRawMock).toHaveBeenCalledOnce()
    expect(workspaceUpdateMock).toHaveBeenCalledWith({
      where: { id: "ws_1", trialStartedAt: null },
      data: expect.objectContaining({ plan: "FREE", deepAllowed: false }),
    })
    expect(billingUpsertMock).toHaveBeenCalledOnce()
    expect(usageCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws_1",
        kind: "trial_grant",
        quantity: TRIAL_AGENT_MINUTES,
      }),
    })
    expect(result).toMatchObject({ started: true, alreadyUsed: false })
  })

  it("does not grant another trial when the user already used one", async () => {
    const startedAt = new Date("2026-08-01T00:00:00.000Z")
    membershipFindManyMock.mockResolvedValueOnce([
      { workspaceId: "ws_1" },
      { workspaceId: "ws_other" },
    ])
    workspaceFindFirstMock.mockImplementationOnce(
      async ({ where }: { where: { id: { in: string[] } } }) => {
        // Workspace and WorkspaceMember intentionally have no RLS policy and are
        // excluded from extension auto-scoping. The ws_1 transaction GUC only
        // filters RLS-protected entitlement tables, so ws_other remains visible.
        expect(where.id.in).toEqual(["ws_1", "ws_other"])
        return { id: "ws_other", trialStartedAt: startedAt }
      }
    )

    const result = await startTrial("ws_1", "user_1")

    expect(withWorkspaceRLSMock).toHaveBeenCalledWith("ws_1", expect.any(Function))
    expect(membershipFindManyMock).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      select: { workspaceId: true },
    })
    expect(result).toMatchObject({ started: false, alreadyUsed: true })
    expect(workspaceUpdateMock).not.toHaveBeenCalled()
    expect(usageCreateMock).not.toHaveBeenCalled()
  })
})
