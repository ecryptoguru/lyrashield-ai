import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  createScan: vi.fn(),
  claimDueSchedule: vi.fn(),
  getDueSchedules: vi.fn(),
  getNextRunAt: vi.fn(),
  updateScanStatus: vi.fn(),
  prisma: {
    scan: {
      count: vi.fn(),
    },
    schedule: {
      update: vi.fn(),
    },
  },
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

import {
  createScan,
  claimDueSchedule,
  getDueSchedules,
  getNextRunAt,
  prisma,
  updateScanStatus,
} from "@lyrashield/db"
import { assertScanWorkerAvailable, enqueueScan } from "./queue"
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
  target: { id: "target-1", name: "Example", type: "WEB_APP", url: "https://example.com" },
}

const mockPrisma = prisma as unknown as {
  scan: { count: ReturnType<typeof vi.fn> }
  schedule: { update: ReturnType<typeof vi.fn> }
}

describe("processDueSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getDueSchedules).mockResolvedValue([schedule] as never)
    vi.mocked(getNextRunAt).mockReturnValue(new Date("2026-01-04T00:00:00Z"))
    vi.mocked(createScan).mockResolvedValue({ id: "scan-1" } as never)
    vi.mocked(enqueueScan).mockResolvedValue("scan-1")
    vi.mocked(assertScanWorkerAvailable).mockResolvedValue(undefined)
    vi.mocked(updateScanStatus).mockResolvedValue({ id: "scan-1" } as never)
    vi.mocked(claimDueSchedule).mockResolvedValue(true)
    mockPrisma.scan.count.mockResolvedValue(0)
    mockPrisma.schedule.update.mockResolvedValue(schedule)
  })

  it("creates and enqueues a scan for a due schedule", async () => {
    const now = new Date("2026-01-01T12:00:00Z")

    const enqueued = await processDueSchedules(now)

    expect(enqueued).toBe(1)
    expect(claimDueSchedule).toHaveBeenCalledWith(
      "schedule-1",
      now,
      new Date("2026-01-04T00:00:00Z")
    )
    expect(createScan).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetId: "target-1",
      goal: "WEEKLY_MONITOR",
      mode: "SAFE",
      createdById: "user-1",
      triggerType: "schedule",
    })
    expect(enqueueScan).toHaveBeenCalledWith({
      scanId: "scan-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      goal: "WEEKLY_MONITOR",
      mode: "SAFE",
    })
  })

  it("skips queueing when the target already has an active scan", async () => {
    mockPrisma.scan.count.mockResolvedValue(1)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(createScan).not.toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it("skips a schedule another worker has already claimed", async () => {
    vi.mocked(claimDueSchedule).mockResolvedValue(false)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(createScan).not.toHaveBeenCalled()
  })

  it("does not advance a schedule when worker availability is lost", async () => {
    vi.mocked(assertScanWorkerAvailable).mockRejectedValue(new Error("worker unavailable"))

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(claimDueSchedule).not.toHaveBeenCalled()
    expect(createScan).not.toHaveBeenCalled()
  })

  it("disables schedules with unsupported cron expressions", async () => {
    vi.mocked(getNextRunAt).mockReturnValue(null)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(mockPrisma.schedule.update).toHaveBeenCalledWith({
      where: { id: "schedule-1" },
      data: { enabled: false },
    })
    expect(createScan).not.toHaveBeenCalled()
  })

  it("marks the created scan failed when queueing fails", async () => {
    vi.mocked(enqueueScan).mockRejectedValue(new Error("redis unavailable"))

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(0)
    expect(updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "QUEUE",
      errorMessage: "Scan worker became unavailable while queueing the scheduled scan",
    })
  })

  it("continues processing other schedules when one schedule fails", async () => {
    const secondSchedule = { ...schedule, id: "schedule-2", targetId: "target-2" }
    vi.mocked(getDueSchedules).mockResolvedValue([schedule, secondSchedule] as never)
    vi.mocked(claimDueSchedule)
      .mockRejectedValueOnce(new Error("database timeout") as never)
      .mockResolvedValueOnce(true)

    const enqueued = await processDueSchedules()

    expect(enqueued).toBe(1)
    expect(createScan).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "target-2",
        triggerType: "schedule",
      })
    )
    expect(enqueueScan).toHaveBeenCalledTimes(1)
  })
})
