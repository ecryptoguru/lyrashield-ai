import { describe, expect, it, vi } from "vitest"
import {
  reapStaleScanResources,
  type StaleResourceReaperDependencies,
} from "./stale-resource-reaper"

const HOUR = 60 * 60 * 1000

function dependencies(
  overrides: Partial<StaleResourceReaperDependencies> = {}
): StaleResourceReaperDependencies {
  return {
    activeScanIds: vi.fn().mockResolvedValue(new Set<string>()),
    containers: vi.fn().mockResolvedValue([]),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    directories: vi.fn().mockResolvedValue([]),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("reapStaleScanResources", () => {
  it("removes only aged, stopped resources that do not belong to an active scan", async () => {
    const deps = dependencies({
      activeScanIds: vi.fn().mockResolvedValue(new Set(["active-scan"])),
      containers: vi.fn().mockResolvedValue([
        { id: "stale-container", scanId: "stale-scan", createdAt: 0, running: false },
        { id: "active-container", scanId: "active-scan", createdAt: 0, running: false },
        { id: "running-container", scanId: "orphaned-running", createdAt: 0, running: true },
      ]),
      directories: vi.fn().mockResolvedValue([
        { path: "/owned/stale", scanId: "stale-scan", modifiedAt: 0 },
        { path: "/owned/active", scanId: "active-scan", modifiedAt: 0 },
        { path: "/owned/recent", scanId: "recent-scan", modifiedAt: 99 * HOUR },
      ]),
    })

    await expect(
      reapStaleScanResources({ dependencies: deps, now: 100 * HOUR, minimumAgeMs: 24 * HOUR })
    ).resolves.toEqual({ containersRemoved: 1, directoriesRemoved: 1, skippedActive: 2, skippedRunning: 1 })

    expect(deps.removeContainer).toHaveBeenCalledWith("stale-container")
    expect(deps.removeContainer).not.toHaveBeenCalledWith("active-container")
    expect(deps.removeContainer).not.toHaveBeenCalledWith("running-container")
    expect(deps.removeDirectory).toHaveBeenCalledWith("/owned/stale")
    expect(deps.removeDirectory).not.toHaveBeenCalledWith("/owned/active")
    expect(deps.removeDirectory).not.toHaveBeenCalledWith("/owned/recent")
  })

  it("fails closed when active scan ownership cannot be determined", async () => {
    const deps = dependencies({
      activeScanIds: vi.fn().mockRejectedValue(new Error("database unavailable")),
      containers: vi.fn().mockResolvedValue([
        { id: "stale-container", scanId: "stale-scan", createdAt: 0, running: false },
      ]),
    })

    await expect(
      reapStaleScanResources({ dependencies: deps, now: 100 * HOUR, minimumAgeMs: 24 * HOUR })
    ).resolves.toEqual({ containersRemoved: 0, directoriesRemoved: 0, skippedActive: 0, skippedRunning: 0 })
    expect(deps.removeContainer).not.toHaveBeenCalled()
    expect(deps.removeDirectory).not.toHaveBeenCalled()
  })
})
