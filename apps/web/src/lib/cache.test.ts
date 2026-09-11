import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((callback) => callback),
}))

const cookiesGet = vi.fn()
const workspaceMemberFindMany = vi.fn()

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: (name: string) => cookiesGet(name) })),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspaceMember: { findMany: (...args: unknown[]) => workspaceMemberFindMany(...args) },
  },
  listFindings: vi.fn(),
}))
vi.mock("@lyrashield/auth/server", () => ({ getSession: vi.fn() }))
vi.mock("@lyrashield/auth", () => ({ hasPermission: vi.fn(), PERMISSIONS: {} }))
vi.mock("./dashboard-overview", () => ({ getDashboardOverview: vi.fn() }))

import { revalidateTag, unstable_cache } from "next/cache"
import { getSession } from "@lyrashield/auth/server"
import { getDashboardOverview } from "./dashboard-overview"
import {
  dashboardCacheTag,
  getCachedDashboardOverview,
  getCachedWorkspaceContext,
  revalidateDashboardAggregates,
} from "./cache"

describe("dashboard cache", () => {
  beforeEach(() => vi.clearAllMocks())

  it("isolates cache keys and invalidation by workspace", async () => {
    expect(dashboardCacheTag("workspace-a")).toBe("dashboard-aggregates:workspace-a")
    expect(dashboardCacheTag("workspace-a")).not.toBe(dashboardCacheTag("workspace-b"))

    revalidateDashboardAggregates("workspace-a")
    expect(revalidateTag).toHaveBeenCalledWith("dashboard-aggregates:workspace-a", {
      expire: 0,
    })

    vi.mocked(getDashboardOverview).mockResolvedValue({ workspaceId: "workspace-a" } as never)
    await getCachedDashboardOverview("workspace-a")
    expect(unstable_cache).toHaveBeenCalledWith(
      expect.any(Function),
      ["dashboard-overview", "workspace-a"],
      {
        revalidate: 30,
        tags: ["dashboard-aggregates:workspace-a"],
      }
    )
  })
})

describe("getCachedWorkspaceContext credential binding", () => {
  const membershipA = {
    role: "OWNER",
    workspaceId: "ws-a",
    workspace: { id: "ws-a", name: "Alpha", slug: "alpha", mode: "CLOUD", plan: "FREE" },
  }
  const membershipB = {
    role: "MEMBER",
    workspaceId: "ws-b",
    workspace: { id: "ws-b", name: "Beta", slug: "beta", mode: "CLOUD", plan: "FREE" },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    workspaceMemberFindMany.mockResolvedValue([membershipA, membershipB])
    cookiesGet.mockReturnValue(undefined)
  })

  it("clamps an API-key session to its bound workspace regardless of the cookie", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "u-key",
      apiKey: { keyId: "k-1", workspaceId: "ws-a", scopes: ["read", "write"], prefix: "lsk_x" },
    } as never)
    cookiesGet.mockReturnValue({ value: "ws-b" })

    const ctx = await getCachedWorkspaceContext("u-key")

    expect(ctx.workspaceId).toBe("ws-a")
    expect(ctx.workspaces.map((w) => w.id)).toEqual(["ws-a"])
  })

  it("clamps an OAuth session to its bound workspace regardless of the cookie", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "u-oauth",
      oauth: { userId: "u-oauth", workspaceId: "ws-b", scopes: ["lyrashield.read"] },
    } as never)
    cookiesGet.mockReturnValue({ value: "ws-a" })

    const ctx = await getCachedWorkspaceContext("u-oauth")

    expect(ctx.workspaceId).toBe("ws-b")
    expect(ctx.workspaces.map((w) => w.id)).toEqual(["ws-b"])
  })

  it("lets a browser session keep cross-workspace switching via the cookie", async () => {
    vi.mocked(getSession).mockResolvedValue({ userId: "u-browser" } as never)
    cookiesGet.mockReturnValue({ value: "ws-b" })

    const ctx = await getCachedWorkspaceContext("u-browser")

    expect(ctx.workspaceId).toBe("ws-b")
    expect(ctx.workspaces.map((w) => w.id)).toEqual(["ws-a", "ws-b"])
  })

  it("returns no workspace for a credential session whose creator lost the bound membership", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "u-removed",
      apiKey: { keyId: "k-1", workspaceId: "ws-gone", scopes: ["read"], prefix: "lsk_x" },
    } as never)

    const ctx = await getCachedWorkspaceContext("u-removed")

    expect(ctx.workspaceId).toBeNull()
    expect(ctx.workspaces).toEqual([])
  })
})
