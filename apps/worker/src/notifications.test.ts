import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  createAndSendNotification: vi.fn(),
  sendNotification: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("@lyrashield/db", () => ({
  prisma: { workspace: { findFirst: mocks.findWorkspace } },
  createAndSendNotification: mocks.createAndSendNotification,
}))
vi.mock("@lyrashield/integrations", () => ({ sendNotification: mocks.sendNotification }))
vi.mock("@lyrashield/logger", () => ({ logger: mocks.logger }))

import { notifyCriticalFinding, notifyScanCompleted, notifyScanFailed } from "./notifications"

describe("completion notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createAndSendNotification.mockResolvedValue(undefined)
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
})
