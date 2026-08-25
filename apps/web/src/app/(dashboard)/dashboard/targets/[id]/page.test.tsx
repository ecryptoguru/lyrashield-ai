import { beforeEach, describe, expect, it, vi } from "vitest"

const { findFirst, withWorkspaceRLS, getCachedSession, getCachedWorkspaceId, redirect, notFound } =
  vi.hoisted(() => ({
    findFirst: vi.fn(),
    withWorkspaceRLS: vi.fn(),
    getCachedSession: vi.fn(),
    getCachedWorkspaceId: vi.fn(),
    redirect: vi.fn(() => {
      throw new Error("NEXT_REDIRECT")
    }),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND")
    }),
  }))

vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: (...args: unknown[]) => withWorkspaceRLS(...args),
}))
vi.mock("@/lib/cache", () => ({
  getCachedSession: (...args: unknown[]) => getCachedSession(...args),
  getCachedWorkspaceId: (...args: unknown[]) => getCachedWorkspaceId(...args),
}))
vi.mock("next/navigation", () => ({ redirect, notFound }))

import TargetDetailPage from "./page"

describe("target detail page workspace isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSession.mockResolvedValue({ userId: "user-1" })
    getCachedWorkspaceId.mockResolvedValue("workspace-1")
    findFirst.mockResolvedValue(null)
    withWorkspaceRLS.mockImplementation(
      async (_workspaceId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback({ target: { findFirst } })
    )
  })

  it("sets the active workspace RLS context and scopes the target query", async () => {
    await expect(TargetDetailPage({ params: Promise.resolve({ id: "target-1" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    )

    expect(getCachedWorkspaceId).toHaveBeenCalledWith("user-1")
    expect(withWorkspaceRLS).toHaveBeenCalledWith("workspace-1", expect.any(Function))
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1", workspaceId: "workspace-1", deletedAt: null },
      })
    )
  })
})
