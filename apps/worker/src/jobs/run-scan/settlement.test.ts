import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  prisma: {
    auditLog: { create: vi.fn() },
  },
  debitOverage: vi.fn(),
  enterGrace: vi.fn(),
  recordAgentMinutes: vi.fn(),
  resolveAccountBilling: vi.fn(),
  runWithAccountContext: vi.fn(),
  shouldRecordAgentMinutes: vi.fn(),
  onTerminalError: vi.fn(),
}))

vi.mock("@lyrashield/billing", () => ({
  debitOverage: mocks.debitOverage,
  enterGrace: mocks.enterGrace,
  recordAgentMinutes: mocks.recordAgentMinutes,
  resolveAccountBilling: mocks.resolveAccountBilling,
}))
vi.mock("@lyrashield/db", () => ({
  prisma: mocks.prisma,
  runWithAccountContext: mocks.runWithAccountContext,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("./usage", () => ({
  shouldRecordAgentMinutes: mocks.shouldRecordAgentMinutes,
}))

import { createEngineMinuteMeter } from "./settlement"

const runRecord = { run_id: "scan-1", run_name: "scan-1", status: "completed" } as never

function meter(over: Partial<Parameters<typeof createEngineMinuteMeter>[0]> = {}) {
  return createEngineMinuteMeter({
    scanId: "scan-1",
    workspaceId: "ws-1",
    mode: "DEEP",
    engineBacked: true,
    engineWallClockMs: 60_000,
    sponsorAccountId: "acct-1",
    exitStatus: "COMPLETED",
    runRecord,
    onTerminalError: mocks.onTerminalError,
    ...over,
  })
}

describe("createEngineMinuteMeter outcome matrix", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.shouldRecordAgentMinutes.mockReturnValue(true)
    mocks.runWithAccountContext.mockImplementation(async (_id: string, fn: () => unknown) => fn())
    mocks.recordAgentMinutes.mockResolvedValue({ overageMinutes: 0 })
    mocks.resolveAccountBilling.mockResolvedValue({
      effectivePlan: "LAUNCH_ASSURANCE",
      spendLimitCents: 5000,
    })
    mocks.debitOverage.mockResolvedValue({ debited: true, minutes: 5 })
    mocks.enterGrace.mockResolvedValue({ shouldContinue: true })
    mocks.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" })
  })

  it("bills a completed run through recordAgentMinutes with tx-bound settleOverage", async () => {
    let captured: Record<string, unknown> | undefined
    mocks.recordAgentMinutes.mockImplementation(
      async (_ws: string, _scan: string, _ms: number, opts: Record<string, unknown>) => {
        captured = opts
        return { overageMinutes: 0 }
      }
    )

    await meter()("completed")

    expect(mocks.shouldRecordAgentMinutes).toHaveBeenCalledWith("scan-1", "COMPLETED", runRecord, {
      cancelled: false,
    })
    expect(captured?.outcome).toBe("completed")
    expect(captured?.settleOverage).toBeInstanceOf(Function)
    expect(mocks.debitOverage).not.toHaveBeenCalled()
    expect(mocks.onTerminalError).not.toHaveBeenCalled()
  })

  it("reports partial outcomes as PARTIAL to the usage gate", async () => {
    await meter({ exitStatus: "FAILED" })("partial")

    expect(mocks.shouldRecordAgentMinutes).toHaveBeenCalledWith("scan-1", "PARTIAL", runRecord, {
      cancelled: false,
    })
  })

  it("does no metering at all for a failed billing outcome", async () => {
    await meter()("failed")
    expect(mocks.recordAgentMinutes).not.toHaveBeenCalled()
  })

  it("does no metering when the run produced no billable work", async () => {
    mocks.shouldRecordAgentMinutes.mockReturnValue(false)
    await meter()("completed")
    expect(mocks.recordAgentMinutes).not.toHaveBeenCalled()
  })

  it("debits overage inside the settlement transaction for Launch Assurance sponsors", async () => {
    const tx = { id: "tx-1" }
    mocks.recordAgentMinutes.mockImplementation(
      async (_ws: string, _scan: string, _ms: number, opts: Record<string, never>) => {
        await (opts as Record<string, (t: unknown, m: number) => Promise<void>>).settleOverage(
          tx,
          5
        )
        return { overageMinutes: 0 }
      }
    )

    await meter()("completed")

    expect(mocks.resolveAccountBilling).toHaveBeenCalledWith("acct-1", tx)
    expect(mocks.debitOverage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        workspaceId: "ws-1",
        minutes: 5,
        scanId: "scan-1",
        transaction: tx,
      })
    )
    expect(mocks.enterGrace).not.toHaveBeenCalled()
    expect(mocks.onTerminalError).not.toHaveBeenCalled()
  })

  it("raises STOPPED_BUDGET and audits the refusal when the overage debit falls short", async () => {
    mocks.debitOverage.mockResolvedValue({ debited: true, minutes: 3 })
    const tx = { id: "tx-1" }
    mocks.recordAgentMinutes.mockImplementation(
      async (_ws: string, _scan: string, _ms: number, opts: Record<string, never>) => {
        await (opts as Record<string, (t: unknown, m: number) => Promise<void>>).settleOverage(
          tx,
          5
        )
        return { overageMinutes: 0 }
      }
    )

    await meter()("completed")

    expect(mocks.onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "STOPPED_BUDGET",
        errorCategory: "AGENT_MINUTES_EXHAUSTED",
      })
    )
    expect(mocks.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "billing.scan_settlement_refused" }),
      })
    )
  })

  it("enters grace instead of overage for sponsors without a spend limit", async () => {
    mocks.resolveAccountBilling.mockResolvedValue({
      effectivePlan: "PRO",
      spendLimitCents: 0,
    })
    const tx = { id: "tx-1" }
    mocks.recordAgentMinutes.mockImplementation(
      async (_ws: string, _scan: string, _ms: number, opts: Record<string, never>) => {
        await (opts as Record<string, (t: unknown, m: number) => Promise<void>>).settleOverage(
          tx,
          2
        )
        return { overageMinutes: 0 }
      }
    )

    await meter()("completed")

    expect(mocks.enterGrace).toHaveBeenCalledWith("acct-1", 60_000, tx)
    expect(mocks.debitOverage).not.toHaveBeenCalled()
    expect(mocks.onTerminalError).not.toHaveBeenCalled()
  })

  it("raises the exhaustion terminal error when grace cannot continue", async () => {
    mocks.resolveAccountBilling.mockResolvedValue({
      effectivePlan: "PRO",
      spendLimitCents: 0,
    })
    mocks.enterGrace.mockResolvedValue({ shouldContinue: false })
    mocks.recordAgentMinutes.mockImplementation(
      async (_ws: string, _scan: string, _ms: number, opts: Record<string, never>) => {
        await (opts as Record<string, (t: unknown, m: number) => Promise<void>>).settleOverage(
          undefined,
          2
        )
        return { overageMinutes: 0 }
      }
    )

    await meter()("completed")

    expect(mocks.onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: "AGENT_MINUTES_EXHAUSTED" })
    )
  })

  it("settles cancellation overage after metering without a tx-bound callback", async () => {
    let captured: Record<string, unknown> | undefined
    mocks.recordAgentMinutes.mockImplementation(
      async (_ws: string, _scan: string, _ms: number, opts: Record<string, unknown>) => {
        captured = opts
        return { overageMinutes: 4 }
      }
    )

    await meter()("cancelled")

    expect(captured?.settleOverage).toBeUndefined()
    // Post-meter path resolves billing under an account context, not a tx.
    expect(mocks.runWithAccountContext).toHaveBeenCalledWith("acct-1", expect.any(Function))
    expect(mocks.resolveAccountBilling).toHaveBeenCalledWith("acct-1")
    expect(mocks.debitOverage).toHaveBeenCalledWith(
      expect.objectContaining({ minutes: 4, transaction: undefined })
    )
  })

  it("rethrows a pre-finalization metering failure for billable outcomes", async () => {
    mocks.recordAgentMinutes.mockRejectedValue(new Error("db write lost"))

    await expect(meter()("completed")).rejects.toThrow("db write lost")
    expect(mocks.prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("swallows a metering failure for cancelled scans", async () => {
    mocks.recordAgentMinutes.mockRejectedValue(new Error("db write lost"))

    await expect(meter()("cancelled")).resolves.toBeUndefined()
  })

  it("rethrows a failure once evidence finalization has begun", async () => {
    mocks.recordAgentMinutes.mockImplementation(
      async (_ws: string, _scan: string, _ms: number, opts: Record<string, unknown>) => {
        await (opts.beforeCommit as () => Promise<void>)()
        return { overageMinutes: 0 }
      }
    )

    await expect(
      meter()("completed", async () => {
        throw new Error("evidence write failed")
      })
    ).rejects.toThrow("evidence write failed")
    // Finalization-started failures must not degrade to a refused-settlement audit.
    expect(mocks.prisma.auditLog.create).not.toHaveBeenCalled()
  })
})
