import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getCurrentGateVerdict: vi.fn(), findMany: vi.fn() }))
vi.mock("@lyrashield/db", () => ({
  getCurrentGateVerdict: mocks.getCurrentGateVerdict,
  withWorkspaceRLS: (_workspaceId: string, run: (tx: unknown) => unknown) =>
    run({ target: { findMany: mocks.findMany } }),
}))

import { getGateReadinessTargets } from "./launch-readiness-server"

describe("getGateReadinessTargets", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns insufficient evidence when a target has no gate verdict", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-1", name: "API" }])
    mocks.getCurrentGateVerdict.mockResolvedValue(null)

    const result = await getGateReadinessTargets("workspace-1")

    expect(result[0]).toMatchObject({
      state: "INSUFFICIENT_EVIDENCE",
      applicable: false,
      reasons: [{ code: "NO_GATE_VERDICT" }],
    })
  })

  it("passes the exact release identity to Gate v2", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-1", name: "API" }])
    mocks.getCurrentGateVerdict.mockResolvedValue({
      state: "READY",
      applicability: { applicable: true, reasons: [] },
      historical: { blockingReasons: [] },
    })
    const commit = "a".repeat(40)

    const result = await getGateReadinessTargets("workspace-1", "target-1", {
      expectedCommit: commit,
    })

    expect(mocks.getCurrentGateVerdict).toHaveBeenCalledWith("workspace-1", "target-1", {
      expectedCommit: commit,
      expectedArtifactDigest: undefined,
    })
    expect(result[0]).toMatchObject({ state: "READY", applicable: true })
  })

  it("preserves every target in order while bounding verdict reads", async () => {
    const targets = Array.from({ length: 10 }, (_, index) => ({
      id: `target-${index}`,
      name: `Target ${index}`,
    }))
    mocks.findMany.mockResolvedValue(targets)
    let active = 0
    let peak = 0
    mocks.getCurrentGateVerdict.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return {
        state: "READY",
        applicability: { applicable: true, reasons: [] },
        historical: { blockingReasons: [] },
      }
    })

    const result = await getGateReadinessTargets("workspace-1")

    expect(peak).toBeLessThanOrEqual(4)
    expect(result.map((target) => target.targetId)).toEqual(targets.map((target) => target.id))
  })
})
