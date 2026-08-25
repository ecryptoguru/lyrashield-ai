import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const members = new Map<string, number>()
  const values = new Map<string, string>()
  const commandCalls: Array<{ name: string; args: unknown[] }> = []
  const commandErrors = new Map<string, Error>()
  let existsError: Error | null = null
  const redis = {
    members,
    values,
    defineCommand(name: string) {
      const command = async (...args: unknown[]) => {
        commandCalls.push({ name, args })
        const error = commandErrors.get(name)
        if (error) throw error

        const now = Number(args[1])
        for (const [id, expiry] of members) {
          if (expiry <= now) members.delete(id)
        }

        if (name === "scanWorkerHeartbeat") {
          members.set(String(args[3]), Number(args[2]))
          return 1
        }
        if (name === "scanWorkerReadiness") return members.size
        throw new Error(`Unexpected command: ${name}`)
      }
      Object.assign(redis, { [name]: command })
    },
    async zrem(_key: string, member: string) {
      return members.delete(member) ? 1 : 0
    },
    async zadd(_key: string, score: number, member: string) {
      members.set(member, Number(score))
      return 1
    },
    async exists(key: string) {
      if (existsError) throw existsError
      return values.has(key) ? 1 : 0
    },
  }
  return {
    redis,
    commandCalls,
    commandErrors,
    queueAdd: vi.fn(),
    queueWorkersCount: vi.fn(),
    setExistsError(error: Error | null) {
      existsError = error
    },
  }
})

vi.mock("./redis", () => ({ getRedis: () => mocks.redis }))
vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.queueAdd
    getWorkersCount = mocks.queueWorkersCount
  },
}))

import {
  enqueueScan,
  handoffScanWorker,
  isScanWorkerAvailable,
  registerScanWorker,
  SCAN_WORKER_HEARTBEAT_MS,
  SCAN_WORKER_RESTART_GRACE_MS,
  SCAN_WORKER_TTL_MS,
  ScanWorkerUnavailableError,
  SCAN_ADMISSION_STOP_KEY,
  unregisterScanWorker,
} from "./queue"

describe("scan worker availability", () => {
  beforeEach(() => {
    mocks.redis.members.clear()
    mocks.redis.values.clear()
    mocks.commandCalls.length = 0
    mocks.commandErrors.clear()
    mocks.setExistsError(null)
    mocks.queueAdd.mockReset()
    mocks.queueWorkersCount.mockReset()
    mocks.queueWorkersCount.mockResolvedValue(1)
  })

  it("supports multiple workers and expires stale heartbeats", async () => {
    expect(SCAN_WORKER_HEARTBEAT_MS).toBe(120_000)
    expect(SCAN_WORKER_TTL_MS).toBe(300_000)

    await registerScanWorker("worker-1", 1_000)
    await registerScanWorker("worker-2", 2_000)

    expect(await isScanWorkerAvailable(20_000)).toBe(true)
    await unregisterScanWorker("worker-1")
    expect(await isScanWorkerAvailable(20_000)).toBe(true)
    expect(await isScanWorkerAvailable(5_600_000)).toBe(false)
  })

  it("uses one atomic script command for each heartbeat and readiness check", async () => {
    await registerScanWorker("worker-1", 1_000)

    expect(mocks.commandCalls).toEqual([
      {
        name: "scanWorkerHeartbeat",
        args: ["lyrashield:scan-workers", 1_000, 301_000, "worker-1", 600_000],
      },
    ])

    mocks.commandCalls.length = 0
    expect(await isScanWorkerAvailable(2_000)).toBe(true)
    expect(mocks.commandCalls).toEqual([
      { name: "scanWorkerReadiness", args: ["lyrashield:scan-workers", 2_000] },
    ])
  })

  it("refuses queue submission without a live worker", async () => {
    await expect(
      enqueueScan({
        scanId: "scan-1",
        workspaceId: "workspace-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    ).rejects.toBeInstanceOf(ScanWorkerUnavailableError)
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it("uses the expiring worker heartbeat when Redis does not expose cross-client names", async () => {
    await registerScanWorker("worker-1", 1_000)
    mocks.queueWorkersCount.mockResolvedValue(0)

    expect(await isScanWorkerAvailable(2_000)).toBe(true)
    expect(mocks.queueWorkersCount).not.toHaveBeenCalled()
  })

  it("keeps only a short lease during a planned worker handoff", async () => {
    expect(SCAN_WORKER_RESTART_GRACE_MS).toBe(60_000)

    await registerScanWorker("worker-1", 1_000)
    await handoffScanWorker("worker-1", 2_000)

    expect(await isScanWorkerAvailable(61_999)).toBe(true)
    expect(await isScanWorkerAvailable(62_000)).toBe(false)
  })

  it("keeps readiness and admission unavailable during drain until handoff registration", async () => {
    await registerScanWorker("worker-1", 1_000)
    await unregisterScanWorker("worker-1")

    expect(await isScanWorkerAvailable(2_000)).toBe(false)
    await expect(
      enqueueScan({
        scanId: "scan-during-drain",
        workspaceId: "workspace-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    ).rejects.toBeInstanceOf(ScanWorkerUnavailableError)
    expect(mocks.queueAdd).not.toHaveBeenCalled()

    await handoffScanWorker("worker-1", 3_000)
    expect(await isScanWorkerAvailable(3_000)).toBe(true)
  })

  it("fails queue admission closed while the operator stop is present", async () => {
    await registerScanWorker("worker-1", Date.now())
    mocks.redis.values.set(SCAN_ADMISSION_STOP_KEY, '{"operator":"on-call"}')

    await expect(
      enqueueScan({
        scanId: "scan-stopped",
        workspaceId: "workspace-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    ).rejects.toBeInstanceOf(ScanWorkerUnavailableError)
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it("fails queue admission closed when the stop state cannot be read", async () => {
    await registerScanWorker("worker-1", Date.now())
    mocks.setExistsError(new Error("Redis unavailable"))

    await expect(
      enqueueScan({
        scanId: "scan-uncertain",
        workspaceId: "workspace-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    ).rejects.toBeInstanceOf(ScanWorkerUnavailableError)
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it("fails closed when worker scripts fail", async () => {
    mocks.commandErrors.set("scanWorkerHeartbeat", new Error("Heartbeat script failed"))
    await expect(registerScanWorker("worker-1", Date.now())).rejects.toThrow(
      "Heartbeat script failed"
    )

    mocks.commandErrors.delete("scanWorkerHeartbeat")
    await registerScanWorker("worker-1", Date.now())
    mocks.commandErrors.set("scanWorkerReadiness", new Error("Readiness script failed"))

    expect(await isScanWorkerAvailable()).toBe(false)
    await expect(
      enqueueScan({
        scanId: "scan-script-error",
        workspaceId: "workspace-1",
        targetId: "target-1",
        goal: "TEST_APP",
        mode: "SAFE",
      })
    ).rejects.toBeInstanceOf(ScanWorkerUnavailableError)
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })
})

describe("webhook track retry queue", () => {
  beforeEach(() => {
    mocks.queueAdd.mockReset().mockResolvedValue({ id: "job_9" })
  })

  it("enqueues with a deterministic event+track jobId and BullMQ attempts pinned to 1", async () => {
    const { enqueueWebhookTrackRetry, WEBHOOK_TRACK_RETRY_QUEUE_NAME } = await import("./queue")

    expect(WEBHOOK_TRACK_RETRY_QUEUE_NAME).toBe("webhook-track-retry")

    const id = await enqueueWebhookTrackRetry({
      webhookEventId: "evt_abc",
      track: "license",
    })

    expect(id).toBe("job_9")
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "webhook-track-retry",
      { webhookEventId: "evt_abc", track: "license" },
      { jobId: "evt_abc:license", attempts: 1 }
    )
  })

  it("forwards an optional delay for scheduled next attempts", async () => {
    const { enqueueWebhookTrackRetry } = await import("./queue")

    await enqueueWebhookTrackRetry(
      { webhookEventId: "evt_delay", track: "affiliate" },
      { delayMs: 60_000 }
    )

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "webhook-track-retry",
      { webhookEventId: "evt_delay", track: "affiliate" },
      { jobId: "evt_delay:affiliate", attempts: 1, delay: 60_000 }
    )
  })
})
