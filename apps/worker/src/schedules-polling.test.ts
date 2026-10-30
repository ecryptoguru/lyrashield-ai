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
  ScanEnqueueNotSubmittedError: class extends Error {
    constructor(
      readonly scanId: string,
      cause: unknown
    ) {
      super("Synthetic publication was not submitted", { cause })
    }
  },
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
const pendingPolls: Promise<number>[] = []

function trackPoll(poll: Promise<number>): Promise<number> {
  pendingPolls.push(poll)
  return poll
}

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
    vi.resetAllMocks()
    mocks.entitlement.mockImplementation(() => {
      throw new Error("Entitlement execution is outside this polling test")
    })
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
      await Promise.allSettled(pendingPolls.splice(0))
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

  it("rejects the original delayed row's rewind after healthy later polls progress", async () => {
    const slowRow = deferred()
    mocks.assertScanWorkerAvailable.mockImplementationOnce(() => slowRow.promise)
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(125_000)
    slowRow.resolve()
    await vi.advanceTimersByTimeAsync(55_000)

    const cursors = mocks.getDueSchedules.mock.calls.map(([, cursor]) => cursor ?? null)
    const targets = mocks.count.mock.calls.map(([input]) => input.where.targetId)
    console.info("stale row fence timing evidence", {
      elapsedMs: Date.now() - origin.getTime(),
      cursors,
      visits: targets.length,
      uniqueTargets: new Set(targets).size,
      lastTarget: targets.at(-1),
    })
    expect(cursors).toEqual([null, null, "schedule-050", "schedule-100"])
    expect(targets).toHaveLength(102)
    expect(new Set(targets).size).toBe(101)
    expect(targets.at(-1)).toBe("target-100")
    expect(mocks.createScheduledScan).not.toHaveBeenCalled()
  })

  it("does not start rows returned by an initial query that lost cursor ownership", async () => {
    const read = deferred()
    mocks.getDueSchedules.mockImplementationOnce(async () => {
      await read.promise
      return schedules.slice(0, 50)
    })
    const { processDueSchedules } = await import("./schedules")
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    await processDueSchedules()
    read.resolve()
    await old
    expect(mocks.count).toHaveBeenCalledTimes(50)
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
  })

  it.each([false, true])(
    "does not wrap a stale empty query (nonempty initial cursor: %s)",
    async (seed) => {
      const { processDueSchedules } = await import("./schedules")
      if (seed) await processDueSchedules()
      const read = deferred()
      mocks.getDueSchedules.mockImplementationOnce(async () => {
        await read.promise
        return []
      })
      const old = trackPoll(processDueSchedules())
      await vi.advanceTimersByTimeAsync(0)
      await processDueSchedules()
      const queryCount = mocks.getDueSchedules.mock.calls.length
      read.resolve()
      await old
      expect(mocks.getDueSchedules).toHaveBeenCalledTimes(queryCount)
      await processDueSchedules()
      expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(
        expect.any(Date),
        seed ? "schedule-100" : "schedule-050"
      )
    }
  )

  it("discards a fallback head query when another poll has advanced since the wrap", async () => {
    const { processDueSchedules } = await import("./schedules")
    await processDueSchedules()
    const read = deferred()
    mocks.getDueSchedules.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      await read.promise
      return schedules.slice(0, 50)
    })
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    await processDueSchedules()
    const visits = mocks.count.mock.calls.length
    read.resolve()
    await old
    expect(mocks.count).toHaveBeenCalledTimes(visits)
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
  })

  it("does not let an old short page reset another poll's cursor", async () => {
    const row = deferred()
    mocks.getDueSchedules.mockResolvedValueOnce([schedules[0]])
    mocks.assertScanWorkerAvailable.mockImplementationOnce(() => row.promise)
    const { processDueSchedules } = await import("./schedules")
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    await processDueSchedules()
    row.resolve()
    await old
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
  })

  it("rejects stale ownership after the cursor wraps back to the same head value (ABA)", async () => {
    const row = deferred()
    mocks.assertScanWorkerAvailable.mockImplementationOnce(() => row.promise)
    const { processDueSchedules } = await import("./schedules")
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    await processDueSchedules()
    await processDueSchedules()
    await processDueSchedules()
    // Healthy polls completed all 101 rows and reset the cursor to undefined.
    row.resolve()
    await old
    expect(mocks.count).toHaveBeenCalledTimes(102)
    expect(
      mocks.count.mock.calls.filter(([input]) => input.where.targetId === "target-1")
    ).toHaveLength(1)
    mocks.getDueSchedules.mockResolvedValueOnce([])
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), undefined)
  })

  it("does not revoke a healthy older poll merely because a newer query hangs", async () => {
    const row = deferred()
    const read = deferred()
    mocks.assertScanWorkerAvailable.mockImplementationOnce(() => row.promise)
    const { processDueSchedules } = await import("./schedules")
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    mocks.getDueSchedules.mockImplementationOnce(async () => {
      await read.promise
      return []
    })
    const newer = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    row.resolve()
    await old
    expect(mocks.count).toHaveBeenCalledTimes(50)
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
    const queries = mocks.getDueSchedules.mock.calls.length
    read.resolve()
    await newer
    expect(mocks.getDueSchedules).toHaveBeenCalledTimes(queries)
  })

  it("does not invalidate active work for an empty head query that makes no cursor progress", async () => {
    const row = deferred()
    mocks.assertScanWorkerAvailable.mockImplementationOnce(() => row.promise)
    const { processDueSchedules } = await import("./schedules")
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    mocks.getDueSchedules.mockResolvedValueOnce([])
    await processDueSchedules()
    row.resolve()
    await old
    expect(mocks.count).toHaveBeenCalledTimes(50)
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
  })

  it("finishes a started creation and publication after losing cursor ownership", async () => {
    const creation = deferred()
    mocks.count.mockResolvedValue(0)
    mocks.getDueSchedules.mockResolvedValueOnce(schedules.slice(0, 2))
    // The DB authority is mocked: only this invocation wins its occurrence CAS.
    mocks.createScheduledScan.mockResolvedValue(null).mockImplementationOnce(async () => {
      await creation.promise
      return { id: "owned-scan" }
    })
    const { processDueSchedules } = await import("./schedules")
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    await processDueSchedules()
    expect(mocks.enqueueScan).not.toHaveBeenCalled()
    creation.resolve()
    expect(await old).toBe(1)
    expect(mocks.enqueueScan).toHaveBeenCalledExactlyOnceWith({
      scanId: "owned-scan",
      workspaceId: "workspace-0",
      targetId: "target-0",
      goal: "WEEKLY_MONITOR",
      mode: "SAFE",
    })
    expect(mocks.createScheduledScan).toHaveBeenCalledTimes(51)
    expect(mocks.restoreUnsubmittedScheduleOccurrence).not.toHaveBeenCalled()
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
  })

  it("finishes ambiguous publication without replay or cleanup after losing cursor ownership", async () => {
    const publication = deferred()
    mocks.count.mockResolvedValue(0)
    mocks.getDueSchedules.mockResolvedValueOnce(schedules.slice(0, 2))
    mocks.createScheduledScan.mockResolvedValue(null).mockResolvedValueOnce({ id: "owned-scan" })
    mocks.enqueueScan.mockImplementationOnce(async () => {
      await publication.promise
      throw new Error("Synthetic acknowledgement loss")
    })
    const { processDueSchedules } = await import("./schedules")
    const old = trackPoll(processDueSchedules())
    await vi.advanceTimersByTimeAsync(0)
    await processDueSchedules()
    publication.resolve()
    expect(await old).toBe(0)
    expect(mocks.enqueueScan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scanId: "owned-scan" })
    )
    expect(mocks.createScheduledScan).toHaveBeenCalledTimes(51)
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
    expect(mocks.releaseUnstartedScanSlot).not.toHaveBeenCalled()
    expect(mocks.restoreUnsubmittedScheduleOccurrence).not.toHaveBeenCalled()
    await processDueSchedules()
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
  })

  it.each(["status", "release", "restore"])(
    "finishes proven no-add cleanup paused at %s despite losing cursor ownership",
    async (stage) => {
      const cleanup = deferred()
      const order: string[] = []
      mocks.count.mockResolvedValue(0)
      mocks.getDueSchedules.mockResolvedValueOnce(schedules.slice(0, 2))
      mocks.createScheduledScan.mockResolvedValue(null).mockResolvedValueOnce({ id: "owned-scan" })
      const { ScanEnqueueNotSubmittedError } = await import("@lyrashield/integrations")
      mocks.enqueueScan.mockRejectedValueOnce(
        new ScanEnqueueNotSubmittedError("owned-scan", new Error("Synthetic worker loss"))
      )
      for (const [name, fn] of [
        ["status", mocks.updateScanStatus],
        ["release", mocks.releaseUnstartedScanSlot],
        ["restore", mocks.restoreUnsubmittedScheduleOccurrence],
      ] as const) {
        fn.mockImplementation(async () => {
          order.push(name)
          if (name === stage) await cleanup.promise
          return true
        })
      }
      const { processDueSchedules } = await import("./schedules")
      const old = trackPoll(processDueSchedules())
      await vi.advanceTimersByTimeAsync(0)
      expect(order.at(-1)).toBe(stage)
      await processDueSchedules()
      cleanup.resolve()
      expect(await old).toBe(0)
      expect(order).toEqual(["status", "release", "restore"])
      expect(mocks.updateScanStatus).toHaveBeenCalledExactlyOnceWith(
        "owned-scan",
        "FAILED",
        expect.objectContaining({ errorCategory: "QUEUE" }),
        "workspace-0"
      )
      expect(mocks.releaseUnstartedScanSlot).toHaveBeenCalledExactlyOnceWith(
        "workspace-0",
        "owned-scan"
      )
      expect(mocks.restoreUnsubmittedScheduleOccurrence).toHaveBeenCalledExactlyOnceWith(
        schedules[0],
        "owned-scan",
        origin,
        nextRun
      )
      expect(mocks.enqueueScan).toHaveBeenCalledTimes(1)
      expect(mocks.createScheduledScan).toHaveBeenCalledTimes(51)
      await processDueSchedules()
      expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "schedule-050")
    }
  )

  it("recovers after a failed fallback query without reserving cursor ownership", async () => {
    const { processDueSchedules, startScheduleRunner } = await import("./schedules")
    await processDueSchedules()
    mocks.getDueSchedules
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Synthetic fallback failure"))
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.error).toHaveBeenCalledWith("Schedule runner poll failed", {
      error: "Synthetic fallback failure",
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), undefined)
    expect(mocks.count).toHaveBeenCalledTimes(100)
  })

  it("finishes a started publication after its interval is stopped without scheduling more work", async () => {
    const publication = deferred()
    mocks.getDueSchedules.mockResolvedValueOnce(schedules.slice(0, 2))
    mocks.count.mockResolvedValue(0)
    mocks.enqueueScan.mockImplementationOnce(async () => {
      await publication.promise
      return "synthetic-scan"
    })
    const { startScheduleRunner } = await import("./schedules")
    timer = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.enqueueScan).toHaveBeenCalledTimes(1)
    clearInterval(timer)
    timer = undefined
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.getDueSchedules).toHaveBeenCalledTimes(1)
    publication.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.enqueueScan).toHaveBeenCalledTimes(1)
    expect(mocks.createScheduledScan).toHaveBeenCalledTimes(1)
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
  })
})
