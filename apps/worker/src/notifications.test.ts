import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  createAndSendNotification: vi.fn(),
  sendNotification: vi.fn(),
  getWorkspaceNotificationChannels: vi.fn(),
  sendWorkspaceNotification: vi.fn(),
  withActiveWorkspaceNotificationDestination: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("@lyrashield/db", () => ({
  prisma: { workspace: { findFirst: mocks.findWorkspace } },
  createAndSendNotification: mocks.createAndSendNotification,
  getWorkspaceNotificationChannels: mocks.getWorkspaceNotificationChannels,
  withActiveWorkspaceNotificationDestination: mocks.withActiveWorkspaceNotificationDestination,
}))
vi.mock("@lyrashield/integrations", () => ({
  sendNotification: mocks.sendNotification,
  sendWorkspaceNotification: mocks.sendWorkspaceNotification,
}))
vi.mock("@lyrashield/logger", () => ({ logger: mocks.logger }))

import { notifyCriticalFinding, notifyScanCompleted, notifyScanFailed } from "./notifications"

describe("completion notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createAndSendNotification.mockResolvedValue(undefined)
    mocks.getWorkspaceNotificationChannels.mockResolvedValue([])
    mocks.sendNotification.mockResolvedValue(true)
    mocks.sendWorkspaceNotification.mockResolvedValue(true)
    mocks.withActiveWorkspaceNotificationDestination.mockImplementation(
      async (
        workspaceId: string,
        channel: string,
        send: (configRef: string) => Promise<boolean>
      ) => {
        const destinations = await mocks.getWorkspaceNotificationChannels(workspaceId)
        const destination = destinations.find(
          (item: { channel: string }) => item.channel === channel
        )
        return destination ? send(destination.configRef) : null
      }
    )
  })

  it("uses the caller's workspace name without another workspace read", async () => {
    await notifyScanCompleted("ws-1", "scan-1", "Completed", 1, "Workspace One")
    await notifyCriticalFinding("ws-1", "finding-1", "Critical", "Target One", "Workspace One")

    expect(mocks.findWorkspace).not.toHaveBeenCalled()
    expect(mocks.createAndSendNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workspaceName: "Workspace One" })
    )
    expect(mocks.createAndSendNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceName: "Workspace One" })
    )
  })

  it("logs delivery failure and rejects so callers can observe it", async () => {
    const failure = new Error("notification provider unavailable")
    mocks.createAndSendNotification.mockRejectedValue(failure)
    mocks.findWorkspace.mockResolvedValue({ name: "Workspace One" })

    const results = await Promise.allSettled([
      notifyScanCompleted("ws-1", "scan-1", "Completed", 1),
      notifyCriticalFinding("ws-1", "finding-1", "Critical", "Target One"),
      notifyScanFailed("ws-1", "scan-1", "Failure"),
    ])

    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({ status: "rejected", reason: failure }))
    )
    expect(mocks.logger.error).toHaveBeenCalledTimes(3)
    expect(mocks.logger.error).toHaveBeenCalledWith("Failed to send scan completed notification", {
      error: String(failure),
      scanId: "scan-1",
    })
  })

  it("records only in-app notifications when the workspace has no active destinations", async () => {
    await notifyScanCompleted("ws-1", "scan-1", "Completed", 1)
    const params = mocks.createAndSendNotification.mock.calls[0]![0]
    expect(params.channels).toEqual(["in_app"])
    await expect(
      params.sendFn("slack", { type: "scan.completed", title: "Done", body: "Done" })
    ).resolves.toBe(false)
    expect(mocks.sendNotification).not.toHaveBeenCalled()
    expect(mocks.sendWorkspaceNotification).not.toHaveBeenCalled()
  })

  it("delivers through the configured workspace ref without invoking global webhooks", async () => {
    mocks.getWorkspaceNotificationChannels.mockResolvedValue([
      { channel: "slack", configRef: "s3://bucket/evidence/ws-1/slack" },
      { channel: "discord", configRef: "s3://bucket/evidence/ws-1/discord" },
    ])
    await notifyCriticalFinding("ws-1", "finding-1", "Critical", "Target One")
    const params = mocks.createAndSendNotification.mock.calls[0]![0]
    const payload = { type: "finding.critical", title: "Critical", body: "Details" }
    expect(params.channels).toEqual(["in_app", "slack", "discord"])
    await expect(params.sendFn("slack", payload)).resolves.toBe(true)
    expect(mocks.sendWorkspaceNotification).toHaveBeenCalledWith("slack", payload, {
      workspaceId: "ws-1",
      configRef: "s3://bucket/evidence/ws-1/slack",
    })
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })

  it("binds credential selection to each workspace including failure notifications", async () => {
    mocks.findWorkspace.mockResolvedValue({ name: "Workspace Two" })
    mocks.getWorkspaceNotificationChannels.mockImplementation(async (workspaceId: string) =>
      workspaceId === "ws-1"
        ? [{ channel: "discord", configRef: "s3://bucket/evidence/ws-1/discord" }]
        : []
    )
    await notifyScanCompleted("ws-1", "scan-1", "Completed", 1)
    await notifyScanFailed("ws-2", "scan-2", "Failed")
    expect(mocks.getWorkspaceNotificationChannels.mock.calls).toEqual([["ws-1"], ["ws-2"]])
    const params = mocks.createAndSendNotification.mock.calls[1]![0]
    expect(params.channels).toEqual(["in_app"])
    await expect(
      params.sendFn("discord", { type: "scan.failed", title: "Failure", body: "Failure" })
    ).resolves.toBe(false)
    expect(mocks.sendWorkspaceNotification).not.toHaveBeenCalled()
  })

  it("preserves in-app delivery when optional destination resolution fails", async () => {
    mocks.getWorkspaceNotificationChannels.mockRejectedValue(
      new Error("Secret storage reference unavailable")
    )
    await expect(notifyScanCompleted("ws-1", "scan-1", "Completed", 1)).resolves.toBeUndefined()
    const params = mocks.createAndSendNotification.mock.calls[0]![0]
    expect(params.channels).toEqual(["in_app"])
    const payload = { type: "scan.completed", title: "Done", body: "Done" }
    await expect(params.sendFn("in_app", payload)).resolves.toBe(true)
    await expect(params.sendFn("slack", payload)).resolves.toBe(false)
    await expect(params.sendFn("discord", payload)).resolves.toBe(false)
    expect(mocks.sendNotification).toHaveBeenCalledOnce()
    expect(mocks.sendNotification).toHaveBeenCalledWith("in_app", payload)
    expect(mocks.sendWorkspaceNotification).not.toHaveBeenCalled()
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "Workspace notification destinations unavailable; retaining in-app delivery",
      { workspaceId: "ws-1" }
    )
  })

  it("uses a rotated destination at send time instead of the event's original snapshot", async () => {
    mocks.getWorkspaceNotificationChannels.mockResolvedValue([
      { channel: "discord", configRef: "s3://bucket/evidence/ws-1/old-discord" },
    ])
    await notifyScanCompleted("ws-1", "scan-1", "Completed", 1)
    const params = mocks.createAndSendNotification.mock.calls[0]![0]
    mocks.getWorkspaceNotificationChannels.mockResolvedValue([
      { channel: "discord", configRef: "s3://bucket/evidence/ws-1/new-discord" },
    ])
    const payload = { type: "scan.completed", title: "Done", body: "Done" }
    await expect(params.sendFn("discord", payload)).resolves.toBe(true)
    expect(mocks.sendWorkspaceNotification).toHaveBeenCalledWith("discord", payload, {
      workspaceId: "ws-1",
      configRef: "s3://bucket/evidence/ws-1/new-discord",
    })
  })

  it("skips a destination disconnected before its channel starts sending", async () => {
    mocks.getWorkspaceNotificationChannels.mockResolvedValue([
      { channel: "discord", configRef: "s3://bucket/evidence/ws-1/discord" },
    ])
    await notifyScanCompleted("ws-1", "scan-1", "Completed", 1)
    const params = mocks.createAndSendNotification.mock.calls[0]![0]
    mocks.getWorkspaceNotificationChannels.mockResolvedValue([])
    await expect(
      params.sendFn("discord", { type: "scan.completed", title: "Done", body: "Done" })
    ).resolves.toBe("skipped")
    expect(mocks.sendWorkspaceNotification).not.toHaveBeenCalled()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })

  it("resolves the later channel after a reconnect while the earlier channel was sending", async () => {
    let active = [
      { channel: "slack", configRef: "s3://bucket/evidence/ws-1/slack" },
      { channel: "discord", configRef: "s3://bucket/evidence/ws-1/old-discord" },
    ]
    mocks.getWorkspaceNotificationChannels.mockImplementation(async () => active)
    mocks.sendWorkspaceNotification.mockImplementation(async (channel: string) => {
      if (channel === "slack") {
        active = [
          { channel: "slack", configRef: "s3://bucket/evidence/ws-1/slack" },
          { channel: "discord", configRef: "s3://bucket/evidence/ws-1/new-discord" },
        ]
      }
      return true
    })
    await notifyScanCompleted("ws-1", "scan-1", "Completed", 1)
    const params = mocks.createAndSendNotification.mock.calls[0]![0]
    const payload = { type: "scan.completed", title: "Done", body: "Done" }
    await params.sendFn("slack", payload)
    await params.sendFn("discord", payload)
    expect(mocks.sendWorkspaceNotification).toHaveBeenNthCalledWith(2, "discord", payload, {
      workspaceId: "ws-1",
      configRef: "s3://bucket/evidence/ws-1/new-discord",
    })
  })
})
