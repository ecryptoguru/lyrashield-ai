import { describe, it, expect, afterEach, vi } from "vitest"
import { readFile, stat } from "node:fs/promises"
import {
  MANAGED_REDIS_DRAIN_DELAY_SECONDS,
  MANAGED_REDIS_STALLED_INTERVAL_MS,
  RECONCILIATION_INTERVAL_MS,
  assertWorkerStartupProvenance,
  clearWorkerActive,
  markWorkerActive,
  refreshWorkerReadiness,
  removeWorkerReadiness,
  settleScanWorkerForShutdown,
} from "./index"
import { trackActiveEngineProcess } from "./engine/runner"
import { RECONCILIATION_IDLE_BACKSTOP_MS } from "./queue-reconciliation"

vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    resolveWorkerExecutionProvenance: vi.fn(() => null),
  }
})

import { resolveWorkerExecutionProvenance } from "@lyrashield/config"

describe("worker startup provenance gate", () => {
  afterEach(() => vi.clearAllMocks())

  it("fails closed when production worker provenance cannot be resolved", () => {
    vi.mocked(resolveWorkerExecutionProvenance).mockImplementation(() => {
      throw new Error("Worker execution provenance is incomplete: LYRASHIELD_PRODUCT_REVISION")
    })
    expect(() => assertWorkerStartupProvenance()).toThrow(
      /Worker execution provenance is incomplete/
    )
  })

  it("returns the resolved provenance when configured", () => {
    const provenance = {
      productRevision: "a".repeat(40),
      workerImageDigest: `sha256:${"b".repeat(64)}`,
      engineRevision: "c".repeat(40),
    }
    vi.mocked(resolveWorkerExecutionProvenance).mockReturnValue(provenance as never)
    expect(assertWorkerStartupProvenance()).toEqual(provenance)
  })
})

describe("worker readiness lifecycle", () => {
  afterEach(async () => {
    await removeWorkerReadiness()
    await clearWorkerActive()
  })

  it("writes an ISO timestamp to the readiness marker with 0o600 permissions", async () => {
    await refreshWorkerReadiness()

    const content = await readFile("/tmp/lyrashield-worker-ready", "utf8")
    expect(Date.parse(content)).not.toBeNaN()

    const { mode } = await stat("/tmp/lyrashield-worker-ready")
    expect(mode & 0o777).toBe(0o600)
  })

  it("removes the readiness marker without throwing when it is missing", async () => {
    await removeWorkerReadiness()
    await expect(removeWorkerReadiness()).resolves.toBeUndefined()
  })

  it("paces deterministic idle worker polling and queue reconciliation", () => {
    expect(RECONCILIATION_INTERVAL_MS).toBe(300_000)
    expect(RECONCILIATION_IDLE_BACKSTOP_MS).toBe(3_600_000)
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000
    const baselineIdleCommandsPerWorker =
      thirtyDaysMs / (MANAGED_REDIS_DRAIN_DELAY_SECONDS * 1_000) +
      thirtyDaysMs / MANAGED_REDIS_STALLED_INTERVAL_MS
    const idleReconciliationsPerWorker = thirtyDaysMs / RECONCILIATION_IDLE_BACKSTOP_MS

    expect(baselineIdleCommandsPerWorker).toBe(47_520)
    expect(baselineIdleCommandsPerWorker * 2).toBeLessThan(100_000)
    expect(idleReconciliationsPerWorker).toBe(720)
  })

  it("publishes a root-readable marker while a scan job is active", async () => {
    await markWorkerActive("scan-123")

    expect(await readFile("/tmp/lyrashield-worker-active", "utf8")).toBe("scan-123")
    const { mode } = await stat("/tmp/lyrashield-worker-active")
    expect(mode & 0o777).toBe(0o600)

    await clearWorkerActive()
    await expect(stat("/tmp/lyrashield-worker-active")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("terminates active engines before waiting for BullMQ close", async () => {
    let resolveClose: (() => void) | undefined
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    const terminate = vi.fn()
    const stopTracking = trackActiveEngineProcess(terminate)

    const settling = settleScanWorkerForShutdown(closePromise)
    expect(terminate).toHaveBeenCalledOnce()

    resolveClose?.()
    await expect(settling).resolves.toBe(true)
    stopTracking()
  })

  it("reports a forced exit only after terminating active engines", async () => {
    vi.useFakeTimers()
    const terminate = vi.fn()
    const stopTracking = trackActiveEngineProcess(terminate)

    const settling = settleScanWorkerForShutdown(new Promise<void>(() => {}), 25_000)
    expect(terminate).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(25_000)
    await expect(settling).resolves.toBe(false)

    stopTracking()
    vi.useRealTimers()
  })
})
