import { describe, expect, it, vi } from "vitest"
import { runAccountBillingBackfill } from "./backfill-account-billing"
function fixture() {
  return {
    billingAccount: {
      findMany: vi.fn().mockResolvedValue([{ id: "ba", workspaceId: "ws", accountId: null }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "buyer", emailVerified: true }) },
    usageRecord: {
      findMany: vi.fn().mockResolvedValue([
        { id: "grant", workspaceId: "ws", kind: "pool_grant" },
        { id: "debit", workspaceId: "ws", kind: "agent_minutes", metadata: { scanId: "scan" } },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    minutePack: {
      findMany: vi.fn().mockResolvedValue([{ id: "pack", workspaceId: "ws" }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    scan: { findUnique: vi.fn().mockResolvedValue({ createdById: "coworker" }) },
  }
}
describe("legacy account billing mapping", () => {
  it("leaves ambiguous rows untouched without guessing a workspace owner", async () => {
    const tx = fixture()
    const result = await runAccountBillingBackfill(tx, true)
    expect(result.billingAccounts.unmapped).toHaveLength(1)
    expect(result.usageRecords.unmapped).toBe(2)
    expect(tx.billingAccount.updateMany).not.toHaveBeenCalled()
    expect(tx.usageRecord.updateMany).not.toHaveBeenCalled()
  })
  it("keeps historical grant and debit on the same explicitly mapped owner", async () => {
    const tx = fixture()
    await runAccountBillingBackfill(tx, true, { ba: "buyer" })
    expect(tx.usageRecord.updateMany).toHaveBeenCalledTimes(2)
    for (const [args] of tx.usageRecord.updateMany.mock.calls)
      expect(args.data.accountId).toBe("buyer")
    expect(tx.scan.findUnique).not.toHaveBeenCalled()
  })
  it("dry runs make no writes", async () => {
    const tx = fixture()
    await runAccountBillingBackfill(tx, false, { ba: "buyer" })
    expect(tx.billingAccount.updateMany).not.toHaveBeenCalled()
    expect(tx.usageRecord.updateMany).not.toHaveBeenCalled()
  })
  it("rejects unverified or unknown mappings before writing", async () => {
    const tx = fixture()
    tx.user.findUnique.mockResolvedValue(null)
    await expect(runAccountBillingBackfill(tx, true, { ba: "buyer" })).rejects.toThrow("unverified")
    expect(tx.billingAccount.updateMany).not.toHaveBeenCalled()
  })
})
