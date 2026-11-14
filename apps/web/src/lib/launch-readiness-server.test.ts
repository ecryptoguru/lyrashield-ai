import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getCurrentGateVerdicts: vi.fn(), findMany: vi.fn() }))
vi.mock("@lyrashield/db", () => ({
  getCurrentGateVerdicts: mocks.getCurrentGateVerdicts,
  MAX_GATE_READ_BATCH_TARGETS: 5,
  // Minimal shape mirror: the real parser validates and returns null for
  // anything that is not a supported snapshot; tests pass plain objects.
  parseAssessmentSnapshot: (value: unknown) =>
    value && typeof value === "object" ? (value as { identity?: unknown }) : null,
  withWorkspaceRLS: (_workspaceId: string, run: (tx: unknown) => unknown) =>
    run({ target: { findMany: mocks.findMany } }),
}))

import { getGateReadinessTargets } from "./launch-readiness-server"

describe("getGateReadinessTargets", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns insufficient evidence when a target has no gate verdict", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-1", name: "API" }])
    mocks.getCurrentGateVerdicts.mockResolvedValue(new Map())

    const result = await getGateReadinessTargets("workspace-1")

    expect(result[0]).toMatchObject({
      state: "INSUFFICIENT_EVIDENCE",
      applicable: false,
      identity: null,
      reasons: [{ code: "NO_GATE_VERDICT" }],
    })
  })

  it("passes the exact release identity to the batched gate read", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-1", name: "API" }])
    mocks.getCurrentGateVerdicts.mockResolvedValue(
      new Map([
        [
          "target-1",
          {
            state: "READY",
            applicability: { applicable: true, reasons: [], evaluatedIdentity: null },
            historical: { blockingReasons: [] },
          },
        ],
      ])
    )
    const commit = "a".repeat(40)

    const result = await getGateReadinessTargets("workspace-1", "target-1", {
      expectedCommit: commit,
    })

    expect(mocks.getCurrentGateVerdicts).toHaveBeenCalledWith("workspace-1", ["target-1"], {
      expectedCommit: commit,
      expectedArtifactDigest: undefined,
    })
    expect(result[0]).toMatchObject({ state: "READY", applicable: true })
  })

  it("bounds one batched read and returns an explicit continuation", async () => {
    const targets = Array.from({ length: 10 }, (_, index) => ({
      id: `target-${index}`,
      name: `Target ${index}`,
    }))
    mocks.findMany.mockResolvedValue(targets)
    mocks.getCurrentGateVerdicts.mockImplementation(
      async (_workspaceId: string, ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              state: "READY",
              applicability: { applicable: true, reasons: [], evaluatedIdentity: null },
              historical: { blockingReasons: [] },
            },
          ])
        )
    )

    const result = await getGateReadinessTargets("workspace-1")

    // The v16 2.1 fix: exactly one batched read regardless of target count —
    // never N calls through the single-target gate read.
    expect(mocks.getCurrentGateVerdicts).toHaveBeenCalledTimes(1)
    expect(mocks.getCurrentGateVerdicts).toHaveBeenCalledWith(
      "workspace-1",
      targets.slice(0, 5).map((target) => target.id),
      { expectedCommit: undefined, expectedArtifactDigest: undefined }
    )
    expect(result.map((target) => target.targetId)).toEqual(
      targets.slice(0, 5).map((target) => target.id)
    )
    expect(result.nextCursor).toBe("target-4")
    expect(result.partial).toBe(true)
  })

  it("continues after the cursor without applying it to a selected target", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-6", name: "Next" }])
    mocks.getCurrentGateVerdicts.mockResolvedValue(new Map())
    const page = await getGateReadinessTargets("workspace-1", undefined, {}, "target-4")
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-1", deletedAt: null, id: { gt: "target-4" } },
        take: 6,
      })
    )
    expect(page.partial).toBe(true)
    expect(page.nextCursor).toBeNull()
    await getGateReadinessTargets("workspace-1", "target-6", {}, "target-4")
    expect(mocks.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-1", deletedAt: null, id: "target-6" },
        take: 1,
      })
    )
  })

  it("surfaces the evaluated identity per target for read-only labelling", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-1", name: "API" }])
    const identity = { kind: "COMMIT" as const, value: "b".repeat(40) }
    mocks.getCurrentGateVerdicts.mockResolvedValue(
      new Map([
        [
          "target-1",
          {
            state: "READY",
            applicability: { applicable: true, reasons: [], evaluatedIdentity: identity },
            historical: { blockingReasons: [] },
          },
        ],
      ])
    )

    const result = await getGateReadinessTargets("workspace-1")

    expect(result[0]).toMatchObject({ identity })
  })

  it("reads the assessed identity from the verdict's own snapshot, not the requested one", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-1", name: "API" }])
    const assessed = { kind: "COMMIT" as const, value: "b".repeat(40) }
    const requested = { kind: "COMMIT" as const, value: "f".repeat(40) }
    mocks.getCurrentGateVerdicts.mockResolvedValue(
      new Map([
        [
          "target-1",
          {
            state: "INSUFFICIENT_EVIDENCE",
            applicability: {
              applicable: false,
              reasons: [{ code: "IDENTITY_MISMATCH", message: "Different release." }],
              // On mismatch the gate echoes the REQUESTED identity here —
              // the assessed answer must come from the snapshot instead.
              evaluatedIdentity: requested,
            },
            historical: {
              state: "READY",
              blockingReasons: [],
              assessmentSnapshot: { version: 2, identity: assessed },
            },
          },
        ],
      ])
    )

    const result = await getGateReadinessTargets("workspace-1", "target-1", {
      expectedCommit: requested.value,
    })

    expect(result[0]).toMatchObject({
      identity: requested,
      assessedIdentity: assessed,
      historicalState: "READY",
    })
  })

  it("reports null assessed identity and historical state when no verdict exists", async () => {
    mocks.findMany.mockResolvedValue([{ id: "target-1", name: "API" }])
    mocks.getCurrentGateVerdicts.mockResolvedValue(new Map())

    const result = await getGateReadinessTargets("workspace-1")

    expect(result[0]).toMatchObject({
      assessedIdentity: null,
      historicalState: null,
      state: "INSUFFICIENT_EVIDENCE",
    })
  })
})
