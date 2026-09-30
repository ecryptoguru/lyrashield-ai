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
    queueGetRanges: vi.fn(),
    queueGetJob: vi.fn(),
    queueOptions: [] as Array<Record<string, unknown>>,
    queueReady: vi.fn(async () => {}),
    disconnect: vi.fn(),
    setExistsError(error: Error | null) {
      existsError = error
    },
  }
})

vi.mock("./redis", () => ({ getRedis: () => mocks.redis }))
vi.mock("ioredis", () => ({
  default: class {
    constructor(
      _url: string,
      readonly options: Record<string, unknown>
    ) {}
    on() {
      return this
    }
    disconnect = mocks.disconnect
  },
}))
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(_name: string, options: Record<string, unknown>) {
      mocks.queueOptions.push(options)
    }
    add = mocks.queueAdd
    on() {
      return this
    }
    waitUntilReady = mocks.queueReady
    getWorkersCount = mocks.queueWorkersCount
    getRanges = mocks.queueGetRanges
    getJob = mocks.queueGetJob
  },
}))

import {
  enqueueScan,
  getScanQueuePosition,
  isScanWorkerAvailable,
  registerScanWorker,
  SCAN_WORKER_HEARTBEAT_MS,
  SCAN_WORKER_TTL_MS,
  ScanWorkerUnavailableError,
  SCAN_ADMISSION_STOP_KEY,
  unregisterScanWorker,
} from "./queue"

describe("scan worker availability", () => {
  it("bounds producer commands without offline replay", async () => {
    const { getScanQueue } = await import("./queue")
    getScanQueue()
    expect(mocks.queueOptions[0]?.connection).toMatchObject({
      options: {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        connectTimeout: 1_000,
        commandTimeout: 2_000,
      },
    })
  })
  beforeEach(() => {
    mocks.redis.members.clear()
    mocks.redis.values.clear()
    mocks.commandCalls.length = 0
    mocks.commandErrors.clear()
    mocks.setExistsError(null)
    mocks.queueAdd.mockReset()
    mocks.queueWorkersCount.mockReset()
    mocks.queueGetRanges.mockReset()
    mocks.queueGetJob.mockReset()
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

describe("scan queue position", () => {
  beforeEach(() => {
    mocks.queueGetRanges.mockReset()
    mocks.queueGetJob.mockReset()
  })

  it("reads queue IDs in the same state order without hydrating every job", async () => {
    mocks.queueGetRanges.mockResolvedValue(["scan-1", "scan-2", "scan-3"])
    mocks.queueGetJob.mockResolvedValue({ id: "scan-2" })

    expect(await getScanQueuePosition("scan-2")).toEqual({ position: 2, waiting: 3 })
    expect(mocks.queueGetRanges).toHaveBeenCalledWith(["wait", "delayed", "prioritized"], 0, -1)
    expect(mocks.queueGetJob).toHaveBeenCalledExactlyOnceWith("scan-2")
  })

  it("returns no position for absent or removed jobs", async () => {
    mocks.queueGetRanges.mockResolvedValue(["scan-1", "scan-2"])
    expect(await getScanQueuePosition("scan-3")).toBeNull()
    expect(mocks.queueGetJob).not.toHaveBeenCalled()

    mocks.queueGetJob.mockResolvedValue(null)
    expect(await getScanQueuePosition("scan-2")).toBeNull()
  })

  it("returns no position when the queue read fails", async () => {
    mocks.queueGetRanges.mockRejectedValue(new Error("Redis unavailable"))
    expect(await getScanQueuePosition("scan-1")).toBeNull()
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
      generation: 1,
    })

    expect(id).toBe("job_9")
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "webhook-track-retry",
      { webhookEventId: "evt_abc", track: "license", generation: 1 },
      { jobId: expect.stringMatching(/^track-[a-f0-9]{64}-g1$/), attempts: 1 }
    )
  })

  it("forwards an optional delay for scheduled next attempts", async () => {
    const { enqueueWebhookTrackRetry } = await import("./queue")

    await enqueueWebhookTrackRetry(
      { webhookEventId: "evt_delay", track: "affiliate", generation: 2 },
      { delayMs: 60_000 }
    )

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "webhook-track-retry",
      { webhookEventId: "evt_delay", track: "affiliate", generation: 2 },
      { jobId: expect.stringMatching(/^track-[a-f0-9]{64}-g2$/), attempts: 1, delay: 60_000 }
    )
  })
})

describe("producer deadline ownership", () => {
  const data = {
    scanId: "deadline-scan",
    workspaceId: "ws",
    targetId: "target",
    goal: "review",
    mode: "SAFE" as const,
  }

  beforeEach(async () => {
    mocks.queueReady.mockReset().mockResolvedValue(undefined)
    mocks.queueAdd.mockReset().mockResolvedValue({ id: data.scanId })
    mocks.disconnect.mockClear()
    mocks.redis.members.clear()
    mocks.redis.values.clear()
    mocks.commandErrors.clear()
    await registerScanWorker("deadline-worker")
  })

  it("abandons a stalled ready wait and never adds when that wait resolves late", async () => {
    vi.useFakeTimers()
    let ready: (() => void) | undefined
    mocks.queueReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    )
    const pending = enqueueScan(data)
    const rejected = expect(pending).rejects.toThrow("deadline")
    try {
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
      ready?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.queueAdd).not.toHaveBeenCalled()
      expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps an accepted scan identity when an add acknowledgement is unavailable", async () => {
    mocks.queueAdd.mockRejectedValueOnce(new Error("Command timed out"))
    expect(await enqueueScan(data)).toBe(data.scanId)
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
  })

  it("an older concurrent timeout cannot evict the replacement producer", async () => {
    vi.useFakeTimers()
    const { getScanQueue } = await import("./queue")
    mocks.queueAdd.mockImplementation(() => new Promise(() => {}))
    try {
      const first = enqueueScan({ ...data, scanId: "first" })
      await vi.advanceTimersByTimeAsync(1_000)
      const second = enqueueScan({ ...data, scanId: "second" })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(await first).toBe("first")
      const replacement = getScanQueue()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await second).toBe("second")
      expect(getScanQueue()).toBe(replacement)
    } finally {
      vi.useRealTimers()
    }
  })
})
