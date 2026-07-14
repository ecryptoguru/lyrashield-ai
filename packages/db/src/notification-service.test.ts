import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    notification: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

import { prisma } from "./client"
import {
  createNotification,
  getNotification,
  listNotifications,
  markNotificationSent,
  markNotificationRead,
  markAllNotificationsRead,
  updateNotificationStatus,
  createAndSendNotification,
} from "./notification-service"

const mockPrisma = prisma as unknown as {
  notification: {
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
}

const baseNotification = {
  id: "notif-1",
  workspaceId: "ws-1",
  userId: null,
  channel: "in_app",
  type: "scan.completed",
  title: "Scan Completed",
  body: "Scan finished with 0 findings",
  status: "pending",
  sentAt: null,
  metadata: null,
  deletedAt: null,
  createdAt: new Date("2026-01-01"),
}

describe("notification-service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("marks all notifications read with workspace and recipient scoping", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 })
    await expect(markAllNotificationsRead("ws-1", "user-1")).resolves.toBe(3)
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        userId: "user-1",
        status: { not: "read" },
        deletedAt: null,
      },
      data: { status: "read" },
    })
  })

  describe("createNotification", () => {
    it("creates a notification with pending status", async () => {
      mockPrisma.notification.create.mockResolvedValue(baseNotification)

      const result = await createNotification({
        workspaceId: "ws-1",
        channel: "in_app",
        type: "scan.completed",
        title: "Scan Completed",
        body: "Scan finished",
      })

      expect(result.status).toBe("pending")
      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws-1",
          channel: "in_app",
          type: "scan.completed",
          title: "Scan Completed",
          body: "Scan finished",
          status: "pending",
        },
      })
    })

    it("creates with userId and metadata when provided", async () => {
      mockPrisma.notification.create.mockResolvedValue({ ...baseNotification, userId: "user-1" })

      await createNotification({
        workspaceId: "ws-1",
        userId: "user-1",
        channel: "email",
        type: "finding.critical",
        title: "Critical Finding",
        body: "XSS found",
        metadata: { severity: "CRITICAL" },
      })

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws-1",
          userId: "user-1",
          channel: "email",
          type: "finding.critical",
          title: "Critical Finding",
          body: "XSS found",
          status: "pending",
          metadata: { severity: "CRITICAL" },
        },
      })
    })
  })

  describe("getNotification", () => {
    it("returns notification when found", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(baseNotification)

      const result = await getNotification("notif-1", "ws-1")

      expect(result).not.toBeNull()
      expect(result?.id).toBe("notif-1")
    })

    it("returns null when not found", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null)

      const result = await getNotification("nonexistent", "ws-1")

      expect(result).toBeNull()
    })
  })

  describe("listNotifications", () => {
    it("lists notifications with default limit", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([baseNotification])

      const result = await listNotifications({ workspaceId: "ws-1" })

      expect(result.items).toHaveLength(1)
      expect(result.nextCursor).toBeNull()
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: "ws-1", deletedAt: null },
          take: 21,
        })
      )
    })

    it("returns nextCursor when more results exist", async () => {
      const notifs = Array.from({ length: 21 }, (_, i) => ({
        ...baseNotification,
        id: `notif-${i}`,
      }))
      mockPrisma.notification.findMany.mockResolvedValue(notifs)

      const result = await listNotifications({ workspaceId: "ws-1", limit: 20 })

      expect(result.items).toHaveLength(20)
      expect(result.nextCursor).toBe("notif-20")
    })

    it("filters by status and type", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([])

      await listNotifications({ workspaceId: "ws-1", status: "sent", type: "scan.completed" })

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            workspaceId: "ws-1",
            deletedAt: null,
            status: "sent",
            type: "scan.completed",
          },
        })
      )
    })

    it("includes only the caller's and workspace-wide notifications in a personal feed", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([])

      await listNotifications({ workspaceId: "ws-1", userId: "user-1" })

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            workspaceId: "ws-1",
            deletedAt: null,
            OR: [{ userId: "user-1" }, { userId: null }],
          },
        })
      )
    })
  })

  describe("markNotificationSent", () => {
    it("updates status to sent with sentAt", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(baseNotification)
      mockPrisma.notification.update.mockResolvedValue({
        ...baseNotification,
        status: "sent",
        sentAt: new Date(),
      })

      const result = await markNotificationSent("notif-1", "ws-1")

      expect(result.status).toBe("sent")
      expect(mockPrisma.notification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "sent" }),
        })
      )
    })

    it("throws when notification not found", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null)

      await expect(markNotificationSent("nonexistent", "ws-1")).rejects.toThrow(
        "Notification not found: nonexistent"
      )
    })
  })

  describe("markNotificationRead", () => {
    it("updates status to read", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(baseNotification)
      mockPrisma.notification.update.mockResolvedValue({ ...baseNotification, status: "read" })

      const result = await markNotificationRead("notif-1", "ws-1")

      expect(result.status).toBe("read")
    })

    it("throws when notification not found", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null)

      await expect(markNotificationRead("nonexistent", "ws-1")).rejects.toThrow(
        "Notification not found: nonexistent"
      )
    })
  })

  describe("updateNotificationStatus", () => {
    it("throws on invalid status", async () => {
      await expect(updateNotificationStatus("notif-1", "ws-1", "hacked")).rejects.toThrow(
        "Invalid notification status: hacked"
      )
      expect(mockPrisma.notification.findFirst).not.toHaveBeenCalled()
    })

    it("updates with valid status", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(baseNotification)
      mockPrisma.notification.update.mockResolvedValue({ ...baseNotification, status: "failed" })

      const result = await updateNotificationStatus("notif-1", "ws-1", "failed")

      expect(result.status).toBe("failed")
    })

    it("throws when notification not found", async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null)

      await expect(updateNotificationStatus("nonexistent", "ws-1", "read")).rejects.toThrow(
        "Notification not found: nonexistent"
      )
    })
  })

  describe("createAndSendNotification", () => {
    it("creates notifications and marks them sent when sendFn succeeds", async () => {
      mockPrisma.notification.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: `notif-${data.channel}`, ...data })
      )
      mockPrisma.notification.update.mockResolvedValue({ status: "sent" })

      const sendFn = vi.fn().mockResolvedValue(true)

      await createAndSendNotification({
        workspaceId: "ws-1",
        type: "scan.completed",
        title: "Scan Done",
        body: "All good",
        workspaceName: "Acme",
        sendFn,
      })

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(3)
      expect(sendFn).toHaveBeenCalledTimes(3)
      expect(mockPrisma.notification.update).toHaveBeenCalledTimes(3)
      const updateCalls = mockPrisma.notification.update.mock.calls
      for (const call of updateCalls) {
        expect(call[0].data.status).toBe("sent")
        expect(call[0].data.sentAt).toBeInstanceOf(Date)
      }
    })

    it("marks notifications as failed when sendFn returns false", async () => {
      mockPrisma.notification.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: `notif-${data.channel}`, ...data })
      )
      mockPrisma.notification.update.mockResolvedValue({ status: "failed" })

      const sendFn = vi.fn().mockResolvedValue(false)

      await createAndSendNotification({
        workspaceId: "ws-1",
        type: "scan.failed",
        title: "Scan Failed",
        body: "Bad",
        sendFn,
      })

      const updateCalls = mockPrisma.notification.update.mock.calls
      for (const call of updateCalls) {
        expect(call[0].data.status).toBe("failed")
      }
    })

    it("respects custom channels", async () => {
      mockPrisma.notification.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: `notif-${data.channel}`, ...data })
      )
      mockPrisma.notification.update.mockResolvedValue({ status: "sent" })

      const sendFn = vi.fn().mockResolvedValue(true)

      await createAndSendNotification({
        workspaceId: "ws-1",
        type: "fix.pr_created",
        title: "PR Created",
        body: "See URL",
        channels: ["in_app"],
        sendFn,
      })

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1)
      expect(sendFn).toHaveBeenCalledTimes(1)
    })
  })
})
