import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"

const processBillingDowngradeJobMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const processBillingExpirePacksJobMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const replenishAllowanceCyclesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const runBillingReconciliationMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const recoveryMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ examined: 0, represented: 0, ambiguous: 0 })
)
vi.mock("./jobs/webhook-track-retry.job", () => ({ recoverDueWebhookTrackRetries: recoveryMock }))
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock("./jobs/billing-downgrade.job", () => ({
  processBillingDowngradeJob: processBillingDowngradeJobMock,
}))
vi.mock("./jobs/billing-expire-packs.job", () => ({
  processBillingExpirePacksJob: processBillingExpirePacksJobMock,
}))
vi.mock("./jobs/billing-allowance-replenishment.job", () => ({
  replenishAllowanceCycles: replenishAllowanceCyclesMock,
}))
vi.mock("./jobs/billing-reconciliation.job", () => ({
  runBillingReconciliation: runBillingReconciliationMock,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: loggerMock,
}))

import { startBillingJobsScheduler } from "./billing-jobs-scheduler"

describe("billing jobs scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-28T00:00:00.000Z"))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs report-only reconciliation at startup and every day, independent of maintenance interval", async () => {
    const timers = startBillingJobsScheduler(60 * 60 * 1000)

    expect(timers).toHaveLength(4)
    expect(recoveryMock).toHaveBeenCalledTimes(1)
    expect(runBillingReconciliationMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    expect(runBillingReconciliationMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(runBillingReconciliationMock).toHaveBeenCalledTimes(2)
    expect(recoveryMock).toHaveBeenCalledTimes(25)

    timers.forEach(clearInterval)
  })

  it("raises the provisioned operator alert when the reconciliation job itself fails", async () => {
    runBillingReconciliationMock.mockRejectedValueOnce(new Error("database unavailable"))

    const timers = startBillingJobsScheduler()

    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "operator_alert",
        expect.objectContaining({
          code: "reconciliation_drift",
          alertCount: 1,
          alertSamples: [
            {
              provider: "internal",
              type: "job_failed",
              message: "Billing reconciliation did not complete; see worker error log",
            },
          ],
        })
      )
    })

    timers.forEach(clearInterval)
  })
})
