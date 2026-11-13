import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => {
  const row: Record<string, unknown> = {}
  return { row, rls: vi.fn() }
})
vi.mock("@lyrashield/db", () => ({ withWorkspaceRLS: mocks.rls }))
import { hasActiveFixPrConnection } from "./fix-pr-connection"

describe("fix PR connection authority", () => {
  beforeEach(() => {
    mocks.row = {
      id: "connection",
      workspaceId: "ws",
      type: "GITHUB",
      externalId: "42",
      status: "active",
      deletedAt: null,
    }
    mocks.rls.mockImplementation(async (_workspaceId, fn) =>
      fn({
        integration: {
          findFirst: async ({ where }: { where: Record<string, unknown> }) =>
            Object.entries(where).every(([key, value]) => mocks.row[key] === value)
              ? { id: "connection" }
              : null,
        },
      })
    )
  })
  it("accepts the matching active installation inside workspace RLS", async () => {
    expect(await hasActiveFixPrConnection("ws", 42)).toBe(true)
    expect(mocks.rls).toHaveBeenCalledWith("ws", expect.any(Function))
  })
  it.each([
    ["status", "disabled"],
    ["deletedAt", new Date()],
    ["workspaceId", "other"],
    ["externalId", "43"],
    ["type", "GITLAB"],
  ])("rejects a connection with mismatched %s", async (key, value) => {
    mocks.row[key as string] = value
    expect(await hasActiveFixPrConnection("ws", 42)).toBe(false)
  })
})
