import { beforeEach, describe, expect, it, vi } from "vitest"

const { tx, withWorkspaceRLSMock } = vi.hoisted(() => ({
  tx: {
    $executeRaw: vi.fn(),
    workspace: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    billingAccount: { upsert: vi.fn() },
    usageRecord: { create: vi.fn() },
  },
  withWorkspaceRLSMock: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({ prisma: tx, withWorkspaceRLS: withWorkspaceRLSMock }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn() } }))
import { startTrial, isTrialAvailable } from "./trial"

beforeEach(() => {
  vi.resetAllMocks()
  tx.workspace.findUnique.mockResolvedValue({ plan: "FREE", trialStartedAt: null })
  tx.workspace.findFirst.mockResolvedValue(null)
  tx.user.findUnique.mockResolvedValue({ trialStartedAt: null })
  tx.workspace.updateMany.mockResolvedValue({ count: 1 })
  tx.user.updateMany.mockResolvedValue({ count: 1 })
  withWorkspaceRLSMock.mockImplementation((_id, run) => run(tx))
})

describe("startTrial", () => {
  it("retains old-revision trial history before the durable user marker was written", async () => {
    tx.workspace.findFirst.mockResolvedValue({ id: "legacy" })
    expect(await isTrialAvailable("ws", "user")).toBe(false)
    expect(await startTrial("ws", "user")).toEqual({
      started: false,
      alreadyUsed: true,
      trialEndsAt: null,
    })
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user", trialStartedAt: null },
      data: { trialStartedAt: expect.any(Date) },
    })
    expect(tx.workspace.updateMany).not.toHaveBeenCalled()
    expect(tx.usageRecord.create).not.toHaveBeenCalled()
  })
  it("serializes and claims the user with the entitlement in one scoped transaction", async () => {
    expect(await startTrial("ws", "user")).toMatchObject({ started: true, alreadyUsed: false })
    expect(withWorkspaceRLSMock).toHaveBeenCalledWith("ws", expect.any(Function))
    expect(tx.$executeRaw).toHaveBeenCalledOnce()
    expect(tx.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: "ws", plan: "FREE", trialStartedAt: null },
      data: { trialStartedAt: expect.any(Date), deepAllowed: false },
    })
    expect(tx.usageRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantity: 100, kind: "trial_grant" }),
    })
  })
  it("reuses the creator transaction instead of committing a second transaction", async () => {
    await startTrial("ws", "user", tx as never)
    expect(withWorkspaceRLSMock).not.toHaveBeenCalled()
    expect(tx.usageRecord.create).toHaveBeenCalledOnce()
  })
  it("does not grant again after a durable user claim", async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 })
    expect(await startTrial("ws", "user")).toEqual({
      started: false,
      alreadyUsed: true,
      trialEndsAt: null,
    })
    expect(tx.workspace.updateMany).not.toHaveBeenCalled()
    expect(tx.usageRecord.create).not.toHaveBeenCalled()
  })
  it("returns the existing trial without another grant", async () => {
    tx.workspace.findUnique.mockResolvedValue({ plan: "FREE", trialStartedAt: new Date() })
    expect(await startTrial("ws", "user")).toMatchObject({ started: false, alreadyUsed: false })
    expect(tx.user.updateMany).not.toHaveBeenCalled()
  })
  it("never downgrades a paid workspace", async () => {
    tx.workspace.findUnique.mockResolvedValue({ plan: "PRO", trialStartedAt: null })
    await expect(startTrial("ws", "user")).rejects.toThrow("TRIAL_PAID_PLAN")
    expect(tx.user.updateMany).not.toHaveBeenCalled()
  })
  it("aborts the claim if a paid upgrade wins the conditional write", async () => {
    tx.workspace.updateMany.mockResolvedValue({ count: 0 })
    await expect(startTrial("ws", "user")).rejects.toThrow("TRIAL_PAID_PLAN")
    expect(tx.billingAccount.upsert).not.toHaveBeenCalled()
  })
  it("propagates a grant failure for transaction rollback", async () => {
    tx.usageRecord.create.mockRejectedValue(new Error("grant failed"))
    await expect(startTrial("ws", "user")).rejects.toThrow("grant failed")
  })
})

describe("isTrialAvailable", () => {
  it("requires an unused user and a free workspace with no trial", async () => {
    expect(await isTrialAvailable("ws", "user")).toBe(true)
    tx.user.findUnique.mockResolvedValue({ trialStartedAt: new Date() })
    expect(await isTrialAvailable("ws", "user")).toBe(false)
    tx.user.findUnique.mockResolvedValue(null)
    expect(await isTrialAvailable("ws", "user")).toBe(false)
    tx.user.findUnique.mockResolvedValue({ trialStartedAt: null })
    tx.workspace.findUnique.mockResolvedValue({ plan: "PRO", trialStartedAt: null })
    expect(await isTrialAvailable("ws", "user")).toBe(false)
    tx.workspace.findUnique.mockResolvedValue({ plan: "FREE", trialStartedAt: new Date() })
    expect(await isTrialAvailable("ws", "user")).toBe(false)
  })
})
