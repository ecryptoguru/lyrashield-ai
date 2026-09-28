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

import { notifyCriticalFinding, notifyScanCompleted } from "./notifications"

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
})
