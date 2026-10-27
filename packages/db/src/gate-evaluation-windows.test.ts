import { beforeEach, describe, expect, it, vi } from "vitest"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import { requiredScannersForTarget } from "@lyrashield/gate"

const tx = vi.hoisted(() => ({
  target: { findFirst: vi.fn() },
  scan: { findFirst: vi.fn() },
  scanCoverageReceipt: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  policy: { findFirst: vi.fn() },
  gateVerdict: { create: vi.fn() },
}))
vi.mock("./rls", () => ({
  withWorkspaceRLS: async (_id: string, fn: (tx: unknown) => unknown) => fn(tx),
}))
import { evaluateGateForTarget } from "./gate-evaluation-service"

describe("gate evaluation with PHP Windows applicability evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tx.target.findFirst.mockResolvedValue({ id: "target-1", type: "REPO" })
    tx.scan.findFirst.mockResolvedValue({
      id: "scan-1",
      endedAt: new Date("2026-10-27T00:00:00Z"),
      status: "COMPLETED",
      mode: "STANDARD",
      policyId: "policy-1",
      resultManifest: {
        version: RESULT_MANIFEST_VERSION,
        checksum: "a".repeat(64),
        manifest: {
          sourceExecution: { kind: "deterministic_retest", sourceRevision: "b".repeat(40) },
        },
      },
    })
    tx.policy.findFirst.mockResolvedValue({ id: "policy-1", name: "Policy" })
    tx.finding.findMany.mockResolvedValue([])
    tx.gateVerdict.create.mockResolvedValue({ id: "verdict-1" })
  })

  it.each([
    ["BLOCKED", "INSUFFICIENT_EVIDENCE"],
    ["COMPLETED", "READY"],
    ["NOT_APPLICABLE", "READY"],
    [null, "READY"],
  ] as const)("persists %s scoped evidence as %s", async (status, state) => {
    const receipts = requiredScannersForTarget("REPO").map((scanner) => ({
      scanner,
      controlId: scanner,
      status: "COMPLETED",
      reason: null,
    }))
    if (status)
      receipts.push({
        scanner: "php-windows-brotli",
        controlId: "php-runtime:windows-brotli",
        status,
        reason: null,
      })
    tx.scanCoverageReceipt.findMany.mockResolvedValue(receipts)
    const result = await evaluateGateForTarget("workspace-1", "target-1")
    expect(result?.verdict.state).toBe(state)
    expect(tx.gateVerdict.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace-1",
          targetId: "target-1",
          state,
          inputChecksum: expect.any(String),
          verdictChecksum: expect.any(String),
        }),
      })
    )
    if (status === "BLOCKED")
      expect(result?.verdict.nonCoverage).toContainEqual(
        expect.objectContaining({ controlId: "php-runtime:windows-brotli", status })
      )
  })
})
