import { expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), rls: vi.fn() }))
vi.mock("./client", () => ({ prisma: {} }))
vi.mock("./rls", () => ({ withWorkspaceRLS: mocks.rls }))
import { listRecentAgentOperations } from "./agent-operation-service"
it("keeps operation pages workspace scoped with a deterministic cursor and bounded size", async () => {
  mocks.findMany.mockResolvedValue([])
  mocks.rls.mockImplementation(async (_id, fn) =>
    fn({ agentOperation: { findMany: mocks.findMany } })
  )
  expect(await listRecentAgentOperations("ws-page", 21, "op-last")).toEqual([])
  expect(mocks.rls).toHaveBeenCalledWith("ws-page", expect.any(Function))
  expect(mocks.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { workspaceId: "ws-page" },
      take: 21,
      cursor: { id: "op-last" },
      skip: 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
  )
})
