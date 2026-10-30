import { beforeEach, describe, expect, it, vi } from "vitest"

const schedulerMocks = vi.hoisted(() => ({
  findCurrentDomainProof: vi.fn(),
  runWithAccountContext: vi.fn(),
  evaluateScanEntitlement: vi.fn(),
  notifyScheduleBlocked: vi.fn(),
  relayAvailable: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  releaseUnstartedScanSlot: vi.fn(),
  ACTIVE_SCAN_STATUSES: ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"],
  createScheduledScan: vi.fn(),
  advanceBlockedSchedule: vi.fn(),
  restoreUnsubmittedScheduleOccurrence: vi.fn(),
  getDueSchedules: vi.fn(),
  getNextRunAt: vi.fn(),
  findCurrentDomainProof: schedulerMocks.findCurrentDomainProof,
  runWithAccountContext: schedulerMocks.runWithAccountContext,
  runWithWorkspaceContext: <T>(_wsId: string, fn: () => T): T => fn(),
  updateScanStatus: vi.fn(),
  prisma: {
    scan: {
      count: vi.fn(),
    },
    schedule: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))
vi.mock("@lyrashield/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/integrations")>()
  return {
    ...actual,
    resolveAvailableUrlReview: async (
      input: Parameters<typeof actual.resolveAvailableUrlReview>[0]
    ) => actual.resolveAvailableUrlReview(input, await schedulerMocks.relayAvailable()),
  }
})

vi.mock("@lyrashield/billing", () => ({
  evaluateScanEntitlement: schedulerMocks.evaluateScanEntitlement,
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock("./queue", () => ({
  enqueueScan: vi.fn(),
  assertScanWorkerAvailable: vi.fn(),
}))
vi.mock("./notifications", () => ({
  notifyScheduleBlocked: schedulerMocks.notifyScheduleBlocked,
}))

import {
  createScheduledScan,
  advanceBlockedSchedule,
  restoreUnsubmittedScheduleOccurrence,
  getDueSchedules,
  getNextRunAt,
  prisma,
  updateScanStatus,
} from "@lyrashield/db"
import { assertScanWorkerAvailable, enqueueScan } from "./queue"
import { evaluateScanEntitlement as evaluateEntitlement } from "@lyrashield/billing"
import {
  findCurrentDomainProof as lookupDomainProof,
  runWithAccountContext as withAccountContext,
} from "@lyrashield/db"
import { notifyScheduleBlocked as sendScheduleBlockedNotice } from "./notifications"
import { ScanEnqueueNotSubmittedError } from "@lyrashield/integrations"
import { processDueSchedules } from "./schedules"

const schedule = {
  id: "schedule-1",
  workspaceId: "workspace-1",
  targetId: "target-1",
  cron: "0 0 * * 0",
  goal: "WEEKLY_MONITOR",
  mode: "SAFE",
  enabled: true,
  lastRunAt: null,
  nextRunAt: new Date("2026-01-01T00:00:00Z"),
  createdById: "user-1",
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  target: {
    id: "target-1",
    name: "Example",
    type: "WEB_APP",
    url: "https://example.com",
    apiSpecUrl: null,
  },
}

const mockPrisma = prisma as unknown as {
  scan: { count: ReturnType<typeof vi.fn> }
  schedule: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> }
}

describe("processDueSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schedulerMocks.relayAvailable.mockResolvedValue(true)
    vi.mocked(getDueSchedules).mockResolvedValue([schedule] as never)
    vi.mocked(getNextRunAt).mockReturnValue(new Date("2026-01-04T00:00:00Z"))
    vi.mocked(createScheduledScan).mockResolvedValue({ id: "scan-1" } as never)
    vi.mocked(enqueueScan).mockResolvedValue("scan-1")
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(updateScanStatus).mockResolvedValue({ id: "scan-1" } as never)
    vi.mocked(advanceBlockedSchedule).mockResolvedValue(true)
    vi.mocked(restoreUnsubmittedScheduleOccurrence).mockResolvedValue(true)
    vi.mocked(lookupDomainProof).mockResolvedValue({ domain: "example.com", verified: true })
    vi.mocked(withAccountContext).mockImplementation(async (_accountId, fn) => fn())
    vi.mocked(evaluateEntitlement).mockResolvedValue({ allowed: true } as never)
    vi.mocked(sendScheduleBlockedNotice).mockResolvedValue(undefined)
    mockPrisma.scan.count.mockResolvedValue(0)
    mockPrisma.schedule.update.mockResolvedValue(schedule)
    mockPrisma.schedule.updateMany.mockResolvedValue({ count: 1 })
  })

  it("creates and enqueues a scan for a due schedule", async () => {
    const now = new Date("2026-01-01T12:00:00Z")

    const enqueued = await processDueSchedules(now)

    expect(enqueued).toBe(1)
    expect(advanceBlockedSchedule).not.toHaveBeenCalled()
    expect(createScheduledScan).toHaveBeenCalledWith(
      schedule,
      now,
      new Date("2026-01-04T00:00:00Z")
    )
    expect(enqueueScan).toHaveBeenCalledWith({
      scanId: "scan-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      goal: "WEEKLY_MONITOR",
      mode: "SAFE",
    })
    expect(withAccountContext).toHaveBeenCalledWith("user-1", expect.any(Function))
    expect(evaluateEntitlement).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      mode: "SAFE",
      sponsorAccountId: "user-1",
      mutateOnTrialExpiry: true,
      deferCapacityCheck: true,
    })
  })

  it("retains the pending occurrence when entitlement cannot be read", async () => {
    vi.mocked(evaluateEntitlement).mockRejectedValue(new Error("database timeout"))
    expect(await processDueSchedules()).toBe(0)
    expect(advanceBlockedSchedule).not.toHaveBeenCalled()
    expect(sendScheduleBlockedNotice).not.toHaveBeenCalled()
  })

  it("retains the pending occurrence while the target is active", async () => {
    mockPrisma.scan.count.mockResolvedValue(1)
    expect(await processDueSchedules()).toBe(0)
    expect(advanceBlockedSchedule).not.toHaveBeenCalled()
  })

  it("defers live relay loss without advancing or notifying", async () => {
    schedulerMocks.relayAvailable.mockResolvedValue(false)
    vi.mocked(getDueSchedules).mockResolvedValue([{ ...schedule, mode: "STANDARD" }] as never)
    expect(await processDueSchedules()).toBe(0)
    expect(advanceBlockedSchedule).not.toHaveBeenCalled()
    expect(createScheduledScan).not.toHaveBeenCalled()
    expect(sendScheduleBlockedNotice).not.toHaveBeenCalled()
  })

  it("defers user slot contention without consuming an occurrence", async () => {
    vi.mocked(createScheduledScan).mockRejectedValue(
      Object.assign(new Error("busy"), { code: "SCAN_ALREADY_ACTIVE" })
    )
    expect(await processDueSchedules()).toBe(0)
    expect(advanceBlockedSchedule).not.toHaveBeenCalled()
    expect(sendScheduleBlockedNotice).not.toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it("does not notify when another replica already advanced a blocked occurrence", async () => {
    vi.mocked(evaluateEntitlement).mockResolvedValue({ allowed: false } as never)
    vi.mocked(advanceBlockedSchedule).mockResolvedValue(false)
    expect(await processDueSchedules()).toBe(0)
    expect(sendScheduleBlockedNotice).not.toHaveBeenCalled()
  })

  it("keeps an expired-trial schedule enabled and sends one workspace notice", async () => {
    vi.mocked(evaluateEntitlement).mockResolvedValue({
      allowed: false,
      code: "TRIAL_EXPIRED",
    } as never)

    expect(await processDueSchedules(new Date("2026-01-01T12:00:00Z"))).toBe(0)

    expect(advanceBlockedSchedule).toHaveBeenCalled()
    expect(createScheduledScan).not.toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
    expect(mockPrisma.schedule.update).not.toHaveBeenCalled()
    expect(sendScheduleBlockedNotice).toHaveBeenCalledWith(
      "workspace-1",
      "schedule-1",
      "Example",
      "SCAN_ELIGIBILITY_REQUIRED",
      "2026-01-01"
    )
  })

  it("fails closed when a scheduled URL review has no current domain proof", async () => {
    vi.mocked(getDueSchedules).mockResolvedValue([
      { ...schedule, mode: "STANDARD", target: { ...schedule.target, type: "WEB_APP" } },
    ] as never)
    vi.mocked(lookupDomainProof).mockResolvedValue({ domain: "example.com", verified: false })

    expect(await processDueSchedules(new Date("2026-01-01T12:00:00Z"))).toBe(0)

    expect(lookupDomainProof).toHaveBeenCalledWith("workspace-1", "https://example.com")
    expect(createScheduledScan).not.toHaveBeenCalled()
    expect(sendScheduleBlockedNotice).toHaveBeenCalledWith(
      "workspace-1",
      "schedule-1",
      "Example",
      "DOMAIN_VERIFICATION_REQUIRED",
      "2026-01-01"
    )
  })

  it("fails closed without a persisted schedule creator", async () => {
    vi.mocked(getDueSchedules).mockResolvedValue([{ ...schedule, createdById: null }] as never)

    expect(await processDueSchedules()).toBe(0)
    expect(withAccountContext).not.toHaveBeenCalled()
    expect(createScheduledScan).not.toHaveBeenCalled()
    expect(sendScheduleBlockedNotice).toHaveBeenCalledWith(
      "workspace-1",
      "schedule-1",
      "Example",
      "SCAN_ELIGIBILITY_REQUIRED",
      expect.any(String)
    )
  })

  it("skips queueing when the target already has an active scan", async () => {
    mockPrisma.scan.count.mockResolvedValue(1)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(createScheduledScan).not.toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it("skips a schedule another worker has already claimed", async () => {
    vi.mocked(createScheduledScan).mockResolvedValue(null)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it("does not advance a schedule when worker availability is lost", async () => {
    const secondSchedule = { ...schedule, id: "schedule-2", targetId: "target-2" }
    vi.mocked(getDueSchedules).mockResolvedValue([schedule, secondSchedule] as never)
    vi.mocked(assertScanWorkerAvailable).mockRejectedValue(new Error("worker unavailable"))

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(assertScanWorkerAvailable).toHaveBeenCalledTimes(1)
    expect(advanceBlockedSchedule).not.toHaveBeenCalled()
    expect(createScheduledScan).not.toHaveBeenCalled()
  })

  it("disables schedules with unsupported cron expressions", async () => {
    vi.mocked(getNextRunAt).mockReturnValue(null)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(mockPrisma.schedule.updateMany).toHaveBeenCalledWith({
      where: { id: "schedule-1", workspaceId: "workspace-1", updatedAt: schedule.updatedAt },
      data: {
        enabled: false,
        lastBlockedAt: expect.any(Date),
        lastBlockedReason: "SCHEDULE_CRON_UNSUPPORTED",
      },
    })
    expect(createScheduledScan).not.toHaveBeenCalled()
  })

  it("marks the created scan failed when queueing fails", async () => {
    vi.mocked(enqueueScan).mockRejectedValue(
      new ScanEnqueueNotSubmittedError("scan-1", new Error("redis unavailable"))
    )

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      {
        errorCategory: "QUEUE",
        errorMessage: "Scan worker became unavailable while queueing the scheduled scan",
      },
      "workspace-1"
    )
  })

  it("retains the scan and occurrence on an unknown publication failure", async () => {
    vi.mocked(enqueueScan).mockRejectedValue(new Error("unknown publication state"))
    expect(await processDueSchedules()).toBe(0)
    expect(updateScanStatus).not.toHaveBeenCalled()
    expect(restoreUnsubmittedScheduleOccurrence).not.toHaveBeenCalled()
  })

  it("reaches later due schedules after the first page remains deferred", async () => {
    const deferred = Array.from({ length: 50 }, (_, i) => ({
      ...schedule,
      id: `deferred-${String(i).padStart(3, "0")}`,
      targetId: `busy-${i}`,
    }))
    vi.mocked(getDueSchedules)
      .mockResolvedValueOnce(deferred as never)
      .mockResolvedValueOnce([{ ...schedule, id: "later-eligible" }] as never)
    mockPrisma.scan.count.mockImplementation(async (args: { where?: { targetId?: string } }) =>
      args?.where?.targetId?.startsWith("busy-") ? 1 : 0
    )
    expect(await processDueSchedules()).toBe(0)
    expect(await processDueSchedules()).toBe(1)
    expect(getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "deferred-049")
    expect(createScheduledScan).toHaveBeenCalledWith(
      expect.objectContaining({ id: "later-eligible" }),
      expect.any(Date),
      expect.any(Date)
    )
  })

  it("continues after the last processed key when the poll time budget expires", async () => {
    const first = { ...schedule, id: "budget-1" }
    const second = { ...schedule, id: "budget-2" }
    vi.mocked(getDueSchedules)
      .mockResolvedValueOnce([first, second] as never)
      .mockResolvedValueOnce([second] as never)
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(16_000)
    try {
      expect(await processDueSchedules()).toBe(1)
      expect(await processDueSchedules()).toBe(1)
      expect(getDueSchedules).toHaveBeenLastCalledWith(expect.any(Date), "budget-1")
    } finally {
      clock.mockRestore()
    }
  })

  it("does not reset an existing scan after a mismatched no-add proof", async () => {
    vi.mocked(enqueueScan).mockRejectedValue(
      new ScanEnqueueNotSubmittedError("previous-scan", new Error("not submitted"))
    )
    expect(await processDueSchedules()).toBe(0)
    expect(updateScanStatus).not.toHaveBeenCalled()
    expect(restoreUnsubmittedScheduleOccurrence).not.toHaveBeenCalled()
  })

  it("allows scheduled WEB_APP STANDARD scans after surface review is implemented", async () => {
    vi.mocked(getDueSchedules).mockResolvedValue([
      { ...schedule, mode: "STANDARD", target: { ...schedule.target, type: "WEB_APP" } },
    ] as never)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(1)
    expect(createScheduledScan).toHaveBeenCalled()
  })

  it("advances and records unavailable profiles with a bounded notice", async () => {
    vi.mocked(getDueSchedules).mockResolvedValue([
      { ...schedule, mode: "DEEP", target: { ...schedule.target, type: "API" } },
    ] as never)
    expect(await processDueSchedules(new Date("2026-01-01T12:00:00Z"))).toBe(0)
    expect(advanceBlockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "schedule-1" }),
      expect.any(Date),
      expect.any(Date),
      "SCAN_PROFILE_UNAVAILABLE"
    )
    expect(sendScheduleBlockedNotice).toHaveBeenCalledWith(
      "workspace-1",
      "schedule-1",
      "Example",
      "SCAN_PROFILE_UNAVAILABLE",
      "2026-01-01"
    )
    expect(createScheduledScan).not.toHaveBeenCalled()
  })

  it("allows scheduled API STANDARD scans when an OpenAPI spec is configured", async () => {
    vi.mocked(getDueSchedules).mockResolvedValue([
      {
        ...schedule,
        mode: "STANDARD",
        target: {
          ...schedule.target,
          type: "API",
          apiSpecUrl: "https://api.example.com/openapi.yaml",
        },
      },
    ] as never)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(1)
    expect(createScheduledScan).toHaveBeenCalled()
  })

  it("continues processing other schedules when one schedule fails", async () => {
    const secondSchedule = { ...schedule, id: "schedule-2", targetId: "target-2" }
    vi.mocked(getDueSchedules).mockResolvedValue([schedule, secondSchedule] as never)
    vi.mocked(createScheduledScan)
      .mockRejectedValueOnce(new Error("database timeout") as never)
      .mockResolvedValueOnce({ id: "scan-1" } as never)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(1)
    expect(createScheduledScan).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "target-2",
      }),
      expect.any(Date),
      expect.any(Date)
    )
    expect(enqueueScan).toHaveBeenCalledTimes(1)
  })

  it("enqueues when the workspace is below the cap", async () => {
    // Both guard counts carry workspaceId since the P1-8 fix, so the mock
    // discriminates by the targetId: the target guard passes (0 active),
    // the workspace cap reports 2 of 3.
    mockPrisma.scan.count.mockImplementation(async (args: { where?: { targetId?: string } }) =>
      args?.where?.targetId ? 0 : 2
    )

    const enqueued = await processDueSchedules(new Date("2026-01-01T12:00:00Z"))

    expect(enqueued).toBe(1)
    expect(createScheduledScan).toHaveBeenCalledTimes(1)
  })

  it("skips a scheduled scan when the workspace is at MAX_CONCURRENT_WORKSPACE_SCANS", async () => {
    // Target guard passes (0 active), workspace cap reports the full cap.
    mockPrisma.scan.count.mockImplementation(async (args: { where?: { targetId?: string } }) =>
      args?.where?.targetId ? 0 : 3
    )

    const enqueued = await processDueSchedules(new Date("2026-01-01T12:00:00Z"))

    expect(enqueued).toBe(0)
    expect(createScheduledScan).not.toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
  })
})
