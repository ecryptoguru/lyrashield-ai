import { beforeEach, describe, expect, it, vi } from "vitest"

const claimDueMock = vi.fn()
const recordDeferredMock = vi.fn()
const failTerminallyMock = vi.fn()
const completeMock = vi.fn()
const handleMergedMock = vi.fn()
vi.mock("@lyrashield/db", () => ({
  claimDueLoopClosures: (...args: unknown[]) => claimDueMock(...args),
  recordDeferredLoopClosure: (...args: unknown[]) => recordDeferredMock(...args),
  failLoopClosureTerminally: (...args: unknown[]) => failTerminallyMock(...args),
  completeLoopClosure: (...args: unknown[]) => completeMock(...args),
  handleFixPrMergedAndReevaluate: (...args: unknown[]) => handleMergedMock(...args),
  classifyLoopClosureError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message === "concurrency") return "SCAN_CONCURRENCY_LIMIT"
    if (message === "worker") return "WORKER_UNAVAILABLE"
    if (message === "entitled") return "RETEST_NOT_ENTITLED"
    return "UNEXPECTED_ERROR"
  },
  LOOP_CLOSURE_MAX_ATTEMPTS: 5,
}))
const enqueueScanMock = vi.fn().mockResolvedValue("job-1")
const assertWorkerMock = vi.fn()
vi.mock("@lyrashield/integrations", () => ({
  enqueueScan: (...args: unknown[]) => enqueueScanMock(...args),
  assertScanWorkerAvailable: (...args: unknown[]) => assertWorkerMock(...args),
}))
const assertAllowedMock = vi.fn()
vi.mock("@lyrashield/billing", () => ({
  assertScanAllowed: (...args: unknown[]) => assertAllowedMock(...args),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { processLoopClosureSweep } from "./loop-closure-sweep.job"

const outcome = {
  retestScanId: "scan-retest-1",
  targetId: "target-1",
  goal: "SECURITY_REVIEW",
  mode: "STANDARD",
  policyId: null,
}

const closure = {
  id: "closure-1",
  workspaceId: "ws-1",
  repoFullName: "acme/repo",
  branchName: "lyrashield/fix-abc",
  prNumber: 42,
  attempts: 2,
  lastReason: "SCAN_CONCURRENCY_LIMIT",
}

beforeEach(() => {
  vi.clearAllMocks()
  assertAllowedMock.mockResolvedValue({ allowed: true })
  assertWorkerMock.mockResolvedValue(undefined)
  enqueueScanMock.mockResolvedValue("job-1")
})

describe("processLoopClosureSweep — durable retry with terminal visibility", () => {
  it("completes a deferred closure: retest created, enqueued, closure closed", async () => {
    claimDueMock.mockResolvedValue([closure])
    handleMergedMock.mockResolvedValue({ ...outcome, retestId: "retest-1" })

    const result = await processLoopClosureSweep({ now: new Date() })

    expect(result).toEqual({ claimed: 1, completed: 1, deferred: 0, failedTerminal: 0 })
    expect(handleMergedMock).toHaveBeenCalledWith(
      "ws-1",
      "lyrashield/fix-abc",
      42,
      expect.any(Function),
      "acme/repo"
    )
    expect(enqueueScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: "scan-retest-1", workspaceId: "ws-1" })
    )
    expect(completeMock).toHaveBeenCalledWith("ws-1", "acme/repo", 42)
  })

  it.each([
    ["concurrency", "SCAN_CONCURRENCY_LIMIT"],
    ["worker", "WORKER_UNAVAILABLE"],
    ["entitled", "RETEST_NOT_ENTITLED"],
  ])("defers again with a persisted record when the retry hits '%s'", async (message) => {
    claimDueMock.mockResolvedValue([closure])
    handleMergedMock.mockRejectedValue(new Error(message))

    const result = await processLoopClosureSweep({ now: new Date() })

    expect(result).toEqual({ claimed: 1, completed: 0, deferred: 1, failedTerminal: 0 })
    expect(recordDeferredMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        repoFullName: "acme/repo",
        branchName: "lyrashield/fix-abc",
        attempts: 2,
      })
    )
    expect(failTerminallyMock).not.toHaveBeenCalled()
  })

  it("terminates into a visible failure at the maximum attempt count", async () => {
    claimDueMock.mockResolvedValue([{ ...closure, attempts: 5 }])
    handleMergedMock.mockRejectedValue(new Error("concurrency"))

    const result = await processLoopClosureSweep({ now: new Date() })

    expect(result).toEqual({ claimed: 1, completed: 0, deferred: 0, failedTerminal: 1 })
    expect(failTerminallyMock).toHaveBeenCalledWith(
      "ws-1",
      "acme/repo",
      "lyrashield/fix-abc",
      42,
      "SCAN_CONCURRENCY_LIMIT"
    )
    expect(recordDeferredMock).not.toHaveBeenCalled()
  })

  it("completes without enqueue when the closure has no actionable outcome", async () => {
    claimDueMock.mockResolvedValue([closure])
    handleMergedMock.mockResolvedValue(null)

    const result = await processLoopClosureSweep({ now: new Date() })

    expect(result).toEqual({ claimed: 1, completed: 1, deferred: 0, failedTerminal: 0 })
    expect(enqueueScanMock).not.toHaveBeenCalled()
    expect(completeMock).toHaveBeenCalledWith("ws-1", "acme/repo", 42)
  })

  it("claims nothing when no closure is due", async () => {
    claimDueMock.mockResolvedValue([])

    const result = await processLoopClosureSweep({ now: new Date() })

    expect(result).toEqual({ claimed: 0, completed: 0, deferred: 0, failedTerminal: 0 })
    expect(handleMergedMock).not.toHaveBeenCalled()
  })
})
