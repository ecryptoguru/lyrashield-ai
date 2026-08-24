import { describe, it, expect, afterEach, vi } from "vitest"
import { readFile, stat } from "node:fs/promises"
import {
  RECONCILIATION_INTERVAL_MS,
  clearWorkerActive,
  markWorkerActive,
  refreshWorkerReadiness,
  removeWorkerReadiness,
  settleScanWorkerForShutdown,
} from "./index"
import { trackActiveEngineProcess } from "./engine/runner"

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

  it("paces idle queue reconciliation for managed Redis command budgets", () => {
    expect(RECONCILIATION_INTERVAL_MS).toBe(300_000)
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
