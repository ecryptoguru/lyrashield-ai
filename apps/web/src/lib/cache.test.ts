import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((callback) => callback),
}))

vi.mock("next/headers", () => ({ cookies: vi.fn() }))
vi.mock("@lyrashield/db", () => ({ prisma: {}, listFindings: vi.fn() }))
vi.mock("@lyrashield/auth/server", () => ({ getSession: vi.fn() }))
vi.mock("@lyrashield/auth", () => ({ hasPermission: vi.fn(), PERMISSIONS: {} }))
vi.mock("./dashboard-overview", () => ({ getDashboardOverview: vi.fn() }))

import { revalidateTag, unstable_cache } from "next/cache"
import { getDashboardOverview } from "./dashboard-overview"
import {
  dashboardCacheTag,
  getCachedDashboardOverview,
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
