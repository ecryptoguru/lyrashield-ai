import { beforeEach, describe, expect, it, vi } from "vitest"

const { tx, withWorkspaceRLSMock } = vi.hoisted(() => ({
  tx: {
    $executeRaw: vi.fn(),
    workspace: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    billingAccount: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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
  tx.billingAccount.findFirst.mockResolvedValue(null)
  tx.billingAccount.findUnique.mockResolvedValue(null)
  tx.billingAccount.create.mockResolvedValue({ id: "ba_trial" })
  tx.billingAccount.update.mockResolvedValue({})
  withWorkspaceRLSMock.mockImplementation((_id, run) => run(tx))
})

describe("startTrial", () => {
  it("does not infer trial ownership from a coworker's legacy workspace trial", async () => {
    tx.workspace.findFirst.mockResolvedValue({ id: "legacy" })
    expect(await isTrialAvailable("ws", "user")).toBe(true)
    expect(await startTrial("ws", "user")).toMatchObject({ started: true })
  })
  it("serializes and claims the user with the entitlement in one scoped transaction", async () => {
    expect(await startTrial("ws", "user")).toMatchObject({ started: true, alreadyUsed: false })
    expect(withWorkspaceRLSMock).toHaveBeenCalledWith(
      "ws",
      expect.any(Function),
      expect.objectContaining({ accountId: "user" })
    )
    expect(tx.$executeRaw).toHaveBeenCalledOnce()
    expect(tx.workspace.updateMany).not.toHaveBeenCalled()
    expect(tx.billingAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: "user",
        provider: "trial",
        status: "trialing",
        purchaseWorkspaceId: "ws",
      }),
    })
    expect(tx.usageRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantity: 100, kind: "trial_grant", accountId: "user" }),
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
  it("does not share a coworker's paid plan or trial", async () => {
    tx.workspace.findUnique.mockResolvedValue({ plan: "PRO", trialStartedAt: new Date() })
    expect(await startTrial("ws", "user")).toMatchObject({ started: true })
    expect(tx.workspace.updateMany).not.toHaveBeenCalled()
  })
  it("rejects an account with its own paid subscription", async () => {
    tx.billingAccount.findFirst.mockResolvedValue({ id: "paid" })
    await expect(startTrial("ws", "user")).rejects.toThrow("TRIAL_PAID_PLAN")
    expect(tx.user.updateMany).not.toHaveBeenCalled()
  })
  it("propagates a grant failure for transaction rollback", async () => {
    tx.usageRecord.create.mockRejectedValue(new Error("grant failed"))
    await expect(startTrial("ws", "user")).rejects.toThrow("grant failed")
  })
})

describe("isTrialAvailable", () => {
  it("requires an unused account, independently of workspace billing", async () => {
    expect(await isTrialAvailable("ws", "user")).toBe(true)
    tx.user.findUnique.mockResolvedValue({ trialStartedAt: new Date() })
    expect(await isTrialAvailable("ws", "user")).toBe(false)
    tx.user.findUnique.mockResolvedValue(null)
    expect(await isTrialAvailable("ws", "user")).toBe(false)
    tx.user.findUnique.mockResolvedValue({ trialStartedAt: null })
    tx.workspace.findUnique.mockResolvedValue({ plan: "PRO", trialStartedAt: null })
    expect(await isTrialAvailable("ws", "user")).toBe(true)
    tx.workspace.findUnique.mockResolvedValue({ plan: "FREE", trialStartedAt: new Date() })
    expect(await isTrialAvailable("ws", "user")).toBe(true)
  })
})
