import { describe, it, expect, afterEach, vi } from "vitest"
import { readFile, stat, unlink, writeFile } from "node:fs/promises"
import {
  MANAGED_REDIS_DRAIN_DELAY_SECONDS,
  MANAGED_REDIS_STALLED_INTERVAL_MS,
  RECONCILIATION_INTERVAL_MS,
  acknowledgeEgressDrainRequest,
  advanceReconciliationTimestamp,
  assertWorkerStartupProvenance,
  clearWorkerActive,
  createWorkerHeartbeatController,
  deactivateScanWorkerForDrain,
  failClosedAfterEgressDrainCancellation,
  finalizeScanWorkerRegistrationForShutdown,
  markWorkerActive,
  refreshWorkerReadiness,
  removeWorkerReadiness,
  settleScanWorkerLifecycleForShutdown,
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
    await unlink("/tmp/lyrashield-worker-egress-drain-request").catch(() => {})
    await unlink("/tmp/lyrashield-worker-egress-drain-ready").catch(() => {})
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

  it("keeps the reconciliation timestamp monotonic when ticks finish out of order", () => {
    const olderTickMs = Date.parse("2026-07-18T12:00:00Z")
    const newerTickMs = Date.parse("2026-07-18T12:05:00Z")
    const afterNewerTick = advanceReconciliationTimestamp(olderTickMs, newerTickMs)

    expect(advanceReconciliationTimestamp(afterNewerTick, olderTickMs)).toBe(newerTickMs)
  })

  it("publishes a root-readable marker while a scan job is active", async () => {
    await markWorkerActive("scan-123")

    expect(await readFile("/tmp/lyrashield-worker-active", "utf8")).toBe("scan-123")
    const { mode } = await stat("/tmp/lyrashield-worker-active")
    expect(mode & 0o777).toBe(0o600)

    await clearWorkerActive()
    await expect(stat("/tmp/lyrashield-worker-active")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("stops claims, settles heartbeats, unregisters, and waits for active work before acknowledging", async () => {
    const token = "a".repeat(64)
    await writeFile("/tmp/lyrashield-worker-egress-drain-request", token, { mode: 0o600 })
    const events: string[] = []
    let finishActiveJob: (() => void) | undefined
    const pause = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("pause-started")
          finishActiveJob = resolve
        })
    )
    let finishHeartbeat: (() => void) | undefined
    const register = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("heartbeat-started")
          finishHeartbeat = () => {
            events.push("heartbeat-settled")
            resolve()
          }
        })
    )
    const markReady = vi.fn().mockResolvedValue(undefined)
    const heartbeatController = createWorkerHeartbeatController(register, markReady)
    const inFlightHeartbeat = heartbeatController.heartbeat()
    const unregister = vi.fn(async () => {
      events.push("unregistered")
    })
    const removeReadiness = vi.fn(async () => {
      events.push("readiness-removed")
    })

    const acknowledgement = acknowledgeEgressDrainRequest({ pause }, () =>
      deactivateScanWorkerForDrain(heartbeatController, unregister, removeReadiness)
    )
    await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce())
    expect(events.slice(0, 3)).toEqual(["heartbeat-started", "pause-started", "readiness-removed"])
    expect(unregister).not.toHaveBeenCalled()
    await expect(stat("/tmp/lyrashield-worker-egress-drain-ready")).rejects.toMatchObject({
      code: "ENOENT",
    })

    finishHeartbeat?.()
    await inFlightHeartbeat
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce())
    expect(events).toEqual([
      "heartbeat-started",
      "pause-started",
      "readiness-removed",
      "heartbeat-settled",
      "unregistered",
    ])
    await heartbeatController.heartbeat()
    expect(register).toHaveBeenCalledOnce()
    await expect(stat("/tmp/lyrashield-worker-egress-drain-ready")).rejects.toMatchObject({
      code: "ENOENT",
    })

    finishActiveJob?.()
    await expect(acknowledgement).resolves.toBe(true)
    expect(await readFile("/tmp/lyrashield-worker-egress-drain-ready", "utf8")).toBe(token)
    const { mode } = await stat("/tmp/lyrashield-worker-egress-drain-ready")
    expect(mode & 0o777).toBe(0o600)
  })

  it("rejects an invalid egress drain challenge without pausing claims", async () => {
    await writeFile("/tmp/lyrashield-worker-egress-drain-request", "not-a-valid-token", {
      mode: 0o600,
    })
    const pause = vi.fn().mockResolvedValue(undefined)

    await expect(acknowledgeEgressDrainRequest({ pause }, vi.fn())).rejects.toThrow(
      "Invalid egress drain request token"
    )
    expect(pause).not.toHaveBeenCalled()
  })

  it("does not acknowledge a drain when registry removal fails", async () => {
    await writeFile("/tmp/lyrashield-worker-egress-drain-request", "c".repeat(64), {
      mode: 0o600,
    })
    const pause = vi.fn().mockResolvedValue(undefined)
    const heartbeatController = createWorkerHeartbeatController(
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined)
    )

    await expect(
      acknowledgeEgressDrainRequest({ pause }, () =>
        deactivateScanWorkerForDrain(
          heartbeatController,
          vi.fn().mockRejectedValue(new Error("Redis unavailable")),
          vi.fn().mockResolvedValue(undefined)
        )
      )
    ).rejects.toThrow("Redis unavailable")
    expect(pause).toHaveBeenCalledOnce()
    await expect(stat("/tmp/lyrashield-worker-egress-drain-ready")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("fails closed after rollback instead of starting an unobserved resumed run loop", async () => {
    await writeFile("/tmp/lyrashield-worker-egress-drain-ready", "b".repeat(64), { mode: 0o600 })
    const shutdownDrainedWorker = vi.fn().mockResolvedValue(undefined)

    await expect(failClosedAfterEgressDrainCancellation(shutdownDrainedWorker)).resolves.toBe(true)
    expect(shutdownDrainedWorker).toHaveBeenCalledOnce()
    await expect(stat("/tmp/lyrashield-worker-egress-drain-ready")).rejects.toMatchObject({
      code: "ENOENT",
    })
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

  it("bounds a stalled heartbeat, terminates engines immediately, and suppresses handoff", async () => {
    vi.useFakeTimers()
    const register = vi.fn(() => new Promise<void>(() => {}))
    const heartbeatController = createWorkerHeartbeatController(
      register,
      vi.fn().mockResolvedValue(undefined)
    )
    void heartbeatController.heartbeat()
    const closeWorker = vi.fn().mockResolvedValue(undefined)
    const terminate = vi.fn()
    const stopTracking = trackActiveEngineProcess(terminate)

    const settlement = settleScanWorkerLifecycleForShutdown(
      heartbeatController,
      closeWorker,
      25_000
    )
    expect(closeWorker).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    await heartbeatController.heartbeat()
    expect(register).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(25_000)
    await expect(settlement).resolves.toEqual({
      workerClosed: true,
      heartbeatsStopped: false,
    })

    const retainHandoff = vi.fn().mockResolvedValue(undefined)
    const unregister = vi.fn().mockResolvedValue(undefined)
    await expect(
      finalizeScanWorkerRegistrationForShutdown(true, false, retainHandoff, unregister)
    ).resolves.toBe("skipped")
    expect(retainHandoff).not.toHaveBeenCalled()
    expect(unregister).not.toHaveBeenCalled()

    await expect(
      finalizeScanWorkerRegistrationForShutdown(true, true, retainHandoff, unregister)
    ).resolves.toBe("handoff")
    expect(retainHandoff).toHaveBeenCalledOnce()
    expect(unregister).not.toHaveBeenCalled()

    stopTracking()
    vi.useRealTimers()
  })
})
