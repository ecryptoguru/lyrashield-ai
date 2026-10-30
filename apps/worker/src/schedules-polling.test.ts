import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getDueSchedules: vi.fn(),
  getNextRunAt: vi.fn(),
  createScheduledScan: vi.fn(),
  advanceBlockedSchedule: vi.fn(),
  restoreUnsubmittedScheduleOccurrence: vi.fn(),
  releaseUnstartedScanSlot: vi.fn(),
  updateScanStatus: vi.fn(),
  assertScanWorkerAvailable: vi.fn(),
  enqueueScan: vi.fn(),
  count: vi.fn(),
  entitlement: vi.fn(() => {
    throw new Error("Entitlement execution is outside this polling test")
  }),
  error: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  ...mocks,
  ACTIVE_SCAN_STATUSES: ["QUEUED", "RUNNING"],
  findCurrentDomainProof: vi.fn(),
  // Stub admission without invoking its entitlement callback.
  runWithAccountContext: async () => ({ allowed: true }),
  runWithWorkspaceContext: async (_workspaceId: string, fn: () => unknown) => fn(),
  prisma: { scan: { count: mocks.count }, schedule: { updateMany: vi.fn() } },
}))
vi.mock("@lyrashield/billing", () => ({ evaluateScanEntitlement: mocks.entitlement }))
vi.mock("@lyrashield/types", () => ({ MAX_CONCURRENT_WORKSPACE_SCANS: 3 }))
vi.mock("@lyrashield/integrations", () => ({
  resolveAvailableUrlReview: async () => ({ ok: true, engineBacked: false }),
  ScanEnqueueNotSubmittedError: class extends Error {},
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: mocks.error, info: vi.fn(), warn: vi.fn() },
}))
vi.mock("./queue", () => ({
  assertScanWorkerAvailable: mocks.assertScanWorkerAvailable,
  enqueueScan: mocks.enqueueScan,
}))
vi.mock("./notifications", () => ({ notifyScheduleBlocked: vi.fn() }))

const origin = new Date("2026-10-31T00:00:00Z")
const nextRun = new Date("2026-11-01T00:00:00Z")
const schedules = Array.from({ length: 101 }, (_, index) => ({
  id: `schedule-${String(index + 1).padStart(3, "0")}`,
  workspaceId: `workspace-${index}`,
  targetId: `target-${index}`,
  cron: "0 0 * * *",
  goal: "WEEKLY_MONITOR",
  mode: "SAFE",
  enabled: true,
  lastRunAt: null,
  nextRunAt: new Date("2026-09-01T00:00:00Z"),
  createdById: `user-${index}`,
  deletedAt: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  lastBlockedAt: null,
  lastBlockedReason: null,
  lastScanId: null,
  target: {
    id: `target-${index}`,
    name: "Synthetic target",
    type: "WEB_APP",
    url: "https://example.invalid",
    apiSpecUrl: null,
  },
}))

const pendingOperations: Array<() => void> = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  pendingOperations.push(resolve)
  return { promise, resolve }
}

describe("schedule runner polling (isolated admission)", () => {
  let timer: NodeJS.Timeout | undefined

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(origin)
    mocks.getDueSchedules.mockImplementation(async (_now: Date, afterId?: string) =>
      schedules.filter((schedule) => !afterId || schedule.id > afterId).slice(0, 50)
    )
    mocks.getNextRunAt.mockReturnValue(nextRun)
    mocks.assertScanWorkerAvailable.mockResolvedValue(undefined)
    // Every target is busy: each schedule keeps its single pending occurrence.
    mocks.count.mockResolvedValue(1)
    mocks.createScheduledScan.mockResolvedValue({ id: "synthetic-scan" })
    mocks.enqueueScan.mockResolvedValue("synthetic-scan")
  })

  afterEach(async () => {
    if (timer) clearInterval(timer)
    timer = undefined
    try {
      // Settle delayed polls even when an assertion throws; do not leak old work
      // across module resets or leave cleanup dependent on a passing test.
      for (const resolve of pendingOperations.splice(0)) resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.entitlement).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps healthy polls live while an older due query remains pending", async () => {
    const slowRead = deferred()
    mocks.getDueSchedules.mockImplementationOnce(async () => {
      await slowRead.promise
      return schedules.slice(0, 50)
    })
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(125_000)
    expect(mocks.getDueSchedules).toHaveBeenCalledTimes(3)
    expect(mocks.count).toHaveBeenCalledTimes(100)

    // The old read returns after its cooperative row budget expired. It must
    // execute no stale rows and leave healthy polls' completed cursor intact.
    slowRead.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.count).toHaveBeenCalledTimes(100)
    await vi.advanceTimersByTimeAsync(55_000)

    const cursors = mocks.getDueSchedules.mock.calls.map(([, afterId]) => afterId ?? null)
    const targetVisits = mocks.count.mock.calls.map(([input]) => input.where.targetId)
    console.info("schedule polling timing evidence", {
      elapsedMs: Date.now() - origin.getTime(),
      cursors,
      targetVisits: targetVisits.length,
      uniqueTargets: new Set(targetVisits).size,
      lastTarget: targetVisits.at(-1),
    })
    expect(cursors).toEqual([null, null, "schedule-050", "schedule-100"])
    expect(targetVisits).toHaveLength(101)
    expect(new Set(targetVisits).size).toBe(101)
    expect(targetVisits.at(-1)).toBe("target-100")
    expect(mocks.createScheduledScan).not.toHaveBeenCalled()
    expect(mocks.enqueueScan).not.toHaveBeenCalled()
  })

  it("allows a restarted runner to progress while the stopped runner's query is pending", async () => {
    const slowRead = deferred()
    mocks.getDueSchedules.mockImplementationOnce(async () => {
      await slowRead.promise
      return schedules.slice(0, 50)
    })
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.getDueSchedules).toHaveBeenCalledTimes(1)
    clearInterval(timer)
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getDueSchedules).toHaveBeenCalledTimes(2)
    expect(mocks.count).toHaveBeenCalledTimes(50)
    slowRead.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.count).toHaveBeenCalledTimes(50)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
    expect(mocks.count).toHaveBeenCalledTimes(100)
  })

  it("continues polling after a failed due-row read", async () => {
    mocks.getDueSchedules.mockRejectedValueOnce(new Error("synthetic read failure"))
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.error).toHaveBeenCalledWith("Schedule runner poll failed", {
      error: "synthetic read failure",
    })
    expect(mocks.getDueSchedules).toHaveBeenCalledTimes(2)
    expect(mocks.count).toHaveBeenCalledTimes(50)
  })

  it("coalesces missed cadence into one creation and retains uncertain publication identity", async () => {
    mocks.getDueSchedules.mockResolvedValue([schedules[0]])
    mocks.count.mockResolvedValue(0)
    mocks.enqueueScan.mockRejectedValue(new Error("synthetic acknowledgement loss"))
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getNextRunAt).toHaveBeenCalledWith("0 0 * * *", origin)
    expect(mocks.createScheduledScan).toHaveBeenCalledExactlyOnceWith(schedules[0], origin, nextRun)
    expect(mocks.enqueueScan).toHaveBeenCalledExactlyOnceWith({
      scanId: "synthetic-scan",
      workspaceId: "workspace-0",
      targetId: "target-0",
      goal: "WEEKLY_MONITOR",
      mode: "SAFE",
    })
    expect(mocks.restoreUnsubmittedScheduleOccurrence).not.toHaveBeenCalled()
    expect(mocks.releaseUnstartedScanSlot).not.toHaveBeenCalled()
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
  })

  it("leaves a user-slot deferred occurrence pending without enqueueing", async () => {
    mocks.getDueSchedules.mockResolvedValue([schedules[0]])
    mocks.count.mockResolvedValue(0)
    mocks.createScheduledScan.mockRejectedValue(
      Object.assign(new Error("synthetic busy user slot"), { code: "SCAN_ALREADY_ACTIVE" })
    )
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.createScheduledScan).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueScan).not.toHaveBeenCalled()
    expect(mocks.advanceBlockedSchedule).not.toHaveBeenCalled()
    expect(mocks.restoreUnsubmittedScheduleOccurrence).not.toHaveBeenCalled()
  })

  it("continues to another due row after a row fails", async () => {
    mocks.getDueSchedules.mockResolvedValue(schedules.slice(0, 2))
    mocks.count.mockResolvedValue(0)
    mocks.createScheduledScan.mockRejectedValueOnce(new Error("synthetic row failure"))
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.createScheduledScan).toHaveBeenCalledTimes(2)
    expect(mocks.enqueueScan).toHaveBeenCalledExactlyOnceWith({
      scanId: "synthetic-scan",
      workspaceId: "workspace-1",
      targetId: "target-1",
      goal: "WEEKLY_MONITOR",
      mode: "SAFE",
    })
    expect(mocks.restoreUnsubmittedScheduleOccurrence).not.toHaveBeenCalled()
  })
})
