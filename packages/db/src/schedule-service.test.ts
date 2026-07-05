import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    schedule: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { prisma } from "./client"
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  updateScheduleRunTimes,
  getDueSchedules,
} from "./schedule-service"

const mockPrisma = prisma as unknown as {
  schedule: {
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

const baseSchedule = {
  id: "sched-1",
  workspaceId: "ws-1",
  targetId: "target-1",
  cron: "0 0 * * 0",
  goal: "url_scan",
  mode: "SAFE",
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdById: "user-1",
  deletedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
}

const baseTarget = { id: "target-1", name: "example.com", type: "URL", url: "https://example.com" }

describe("schedule-service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("createSchedule", () => {
    it("creates a schedule with enabled=true", async () => {
      mockPrisma.schedule.create.mockResolvedValue(baseSchedule)

      const result = await createSchedule({
        workspaceId: "ws-1",
        targetId: "target-1",
        cron: "0 0 * * 0",
        goal: "url_scan",
        createdById: "user-1",
      })

      expect(result.enabled).toBe(true)
      expect(mockPrisma.schedule.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws-1",
          targetId: "target-1",
          cron: "0 0 * * 0",
          goal: "url_scan",
          mode: "SAFE",
          createdById: "user-1",
          enabled: true,
        },
      })
    })
  })

  describe("getSchedule", () => {
    it("returns schedule with target when found", async () => {
      mockPrisma.schedule.findFirst.mockResolvedValue({ ...baseSchedule, target: baseTarget })

      const result = await getSchedule("sched-1", "ws-1")

      expect(result).not.toBeNull()
      expect(result?.target.name).toBe("example.com")
    })

    it("returns null when not found", async () => {
      mockPrisma.schedule.findFirst.mockResolvedValue(null)

      const result = await getSchedule("nonexistent", "ws-1")

      expect(result).toBeNull()
    })
  })

  describe("listSchedules", () => {
    it("lists schedules with target relation", async () => {
      mockPrisma.schedule.findMany.mockResolvedValue([{ ...baseSchedule, target: baseTarget }])

      const result = await listSchedules({ workspaceId: "ws-1" })

      expect(result.items).toHaveLength(1)
      expect(result.nextCursor).toBeNull()
      expect(mockPrisma.schedule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { target: { select: { id: true, name: true, type: true, url: true } } },
        })
      )
    })

    it("returns nextCursor when more results exist", async () => {
      const scheds = Array.from({ length: 21 }, (_, i) => ({
        ...baseSchedule,
        id: `sched-${i}`,
        target: baseTarget,
      }))
      mockPrisma.schedule.findMany.mockResolvedValue(scheds)

      const result = await listSchedules({ workspaceId: "ws-1", limit: 20 })

      expect(result.items).toHaveLength(20)
      expect(result.nextCursor).toBe("sched-20")
    })

    it("filters by targetId and enabled", async () => {
      mockPrisma.schedule.findMany.mockResolvedValue([])

      await listSchedules({ workspaceId: "ws-1", targetId: "target-1", enabled: true })

      expect(mockPrisma.schedule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            workspaceId: "ws-1",
            deletedAt: null,
            targetId: "target-1",
            enabled: true,
          },
        })
      )
    })
  })

  describe("updateSchedule", () => {
    it("updates cron and enabled", async () => {
      mockPrisma.schedule.findFirst.mockResolvedValue(baseSchedule)
      mockPrisma.schedule.update.mockResolvedValue({ ...baseSchedule, cron: "0 0 * * 1", enabled: false })

      const result = await updateSchedule("sched-1", "ws-1", { cron: "0 0 * * 1", enabled: false })

      expect(result.cron).toBe("0 0 * * 1")
      expect(result.enabled).toBe(false)
    })

    it("throws when schedule not found", async () => {
      mockPrisma.schedule.findFirst.mockResolvedValue(null)

      await expect(updateSchedule("nonexistent", "ws-1", { enabled: false })).rejects.toThrow(
        "Schedule not found: nonexistent"
      )
    })

    it("updates goal and mode", async () => {
      mockPrisma.schedule.findFirst.mockResolvedValue(baseSchedule)
      mockPrisma.schedule.update.mockResolvedValue({ ...baseSchedule, goal: "sca", mode: "AGGRESSIVE" })

      const result = await updateSchedule("sched-1", "ws-1", { goal: "sca", mode: "AGGRESSIVE" })

      expect(result.goal).toBe("sca")
      expect(mockPrisma.schedule.update).toHaveBeenCalledWith({
        where: { id: "sched-1" },
        data: { goal: "sca", mode: "AGGRESSIVE" },
      })
    })
  })

  describe("deleteSchedule", () => {
    it("soft deletes by setting deletedAt", async () => {
      mockPrisma.schedule.findFirst.mockResolvedValue(baseSchedule)
      mockPrisma.schedule.update.mockResolvedValue({ ...baseSchedule, deletedAt: new Date() })

      await deleteSchedule("sched-1", "ws-1")

      expect(mockPrisma.schedule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        })
      )
    })

    it("throws when schedule not found", async () => {
      mockPrisma.schedule.findFirst.mockResolvedValue(null)

      await expect(deleteSchedule("nonexistent", "ws-1")).rejects.toThrow(
        "Schedule not found: nonexistent"
      )
    })
  })

  describe("updateScheduleRunTimes", () => {
    it("updates lastRunAt and nextRunAt", async () => {
      mockPrisma.schedule.update.mockResolvedValue(baseSchedule)

      const lastRun = new Date("2026-01-01")
      const nextRun = new Date("2026-01-08")

      await updateScheduleRunTimes("sched-1", lastRun, nextRun)

      expect(mockPrisma.schedule.update).toHaveBeenCalledWith({
        where: { id: "sched-1" },
        data: { lastRunAt: lastRun, nextRunAt: nextRun },
      })
    })
  })

  describe("getDueSchedules", () => {
    it("returns enabled schedules with nextRunAt <= now", async () => {
      mockPrisma.schedule.findMany.mockResolvedValue([{ ...baseSchedule, target: baseTarget }])

      const now = new Date("2026-01-01T12:00:00Z")
      const result = await getDueSchedules(now)

      expect(result).toHaveLength(1)
      expect(mockPrisma.schedule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            enabled: true,
            deletedAt: null,
            nextRunAt: { lte: now },
          },
          take: 50,
        })
      )
    })
  })
})
