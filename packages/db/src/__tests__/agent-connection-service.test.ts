import { beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../client"
import { resumeAgentConnection } from "../agent-connection-service"

vi.mock("../client", () => ({
  prisma: {
    agentConnection: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

vi.mock("../rls", () => ({
  withWorkspaceRLS: (_workspaceId: string, callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
}))

describe("agent connection lifecycle", () => {
  beforeEach(() => vi.clearAllMocks())

  it("resumes only a still-paused connection so a concurrent revoke cannot be overwritten", async () => {
    vi.mocked(prisma.agentConnection.updateMany).mockResolvedValueOnce({ count: 0 })

    await expect(resumeAgentConnection("conn-1", "ws-1")).resolves.toBeNull()

    expect(prisma.agentConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "conn-1", workspaceId: "ws-1", status: "PAUSED" },
      data: { status: "ACTIVE", pausedAt: null },
    })
    expect(prisma.agentConnection.findUnique).not.toHaveBeenCalled()
  })
})
