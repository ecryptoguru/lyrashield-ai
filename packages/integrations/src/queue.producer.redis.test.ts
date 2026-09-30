import { createServer, connect, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import Redis from "ioredis"
import { Queue, Worker, type QueueOptions } from "bullmq"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: {
    get REDIS_URL() {
      return process.env.BULLMQ_TEST_PROXY_URL
    },
  },
}))

const fixturePrefix = vi.hoisted(() => `producer-fixture-${Date.now()}-${Math.random()}`)
// Only namespace keys: all commands, scripts and job behavior use real BullMQ.
vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>()
  return {
    ...actual,
    Queue: class extends actual.Queue {
      constructor(name: string, options: QueueOptions) {
        super(name, { ...options, prefix: fixturePrefix })
      }
    },
  }
})

const enabled = process.env.BULLMQ_PRODUCER_REDIS_TEST === "1"
const backendUrl = process.env.BULLMQ_TEST_REDIS_URL ?? ""
const sockets = new Set<Socket>()
const backends = new Set<Socket>()
let blockedId = ""
let blackhole = false
function setBlackhole(value: boolean) {
  blackhole = value
  // Stall response delivery without discarding bytes from an ordered TCP stream.
  for (const backend of backends) {
    if (value) backend.pause()
    else backend.resume()
  }
}
const server = createServer((client) => {
  sockets.add(client)
  const destination = new URL(backendUrl)
  const backend = connect(Number(destination.port), destination.hostname)
  sockets.add(backend)
  backends.add(backend)
  if (blackhole) backend.pause()
  let suppress = false
  client.on("data", (chunk) => {
    if (blockedId && chunk.includes(Buffer.from(blockedId))) suppress = true
    backend.write(chunk)
  })
  backend.on("data", (chunk) => {
    if (!suppress) client.write(chunk)
  })
  client.on("error", () => backend.destroy())
  backend.on("error", () => client.destroy())
  client.on("close", () => {
    sockets.delete(client)
    backend.destroy()
  })
  backend.on("close", () => {
    sockets.delete(backend)
    backends.delete(backend)
    client.destroy()
  })
})
let redis: Redis
let inspect: Queue
let api: typeof import("./queue")
const workerId = `fixture-${randomUUID()}`

describe.skipIf(!enabled)("bounded producers against disposable Redis", () => {
  beforeAll(async () => {
    const url = new URL(backendUrl)
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error("Disposable local Redis required")
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing proxy address")
    url.port = String(address.port)
    process.env.BULLMQ_TEST_PROXY_URL = url.toString()
    api = await import("./queue")
    redis = new Redis(backendUrl, { maxRetriesPerRequest: 1 })
    inspect = new Queue("scans", { connection: { url: backendUrl, maxRetriesPerRequest: 1 } })
    await api.registerScanWorker(workerId)
  })

  afterAll(async () => {
    setBlackhole(false)
    blockedId = ""
    await api?.unregisterScanWorker(workerId)
    await inspect?.close()
    redis?.disconnect()
    const { closeRedis } = await import("./redis")
    await closeRedis()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("retains one scan identity after delivered Lua loses acknowledgement, then deduplicates retry", async () => {
    const scanId = `producer-fixture-${randomUUID()}`
    const data = {
      scanId,
      workspaceId: "fixture",
      targetId: "fixture",
      goal: "fixture",
      mode: "SAFE" as const,
    }
    await api.getScanQueue().waitUntilReady()
    const warmupId = `producer-fixture-${randomUUID()}`
    await api.enqueueScan({ ...data, scanId: warmupId })
    await (await inspect.getJob(warmupId))?.remove()
    blockedId = scanId
    const started = Date.now()
    expect(await api.enqueueScan(data)).toBe(scanId)
    expect(Date.now() - started).toBeLessThan(5_500)
    blockedId = ""
    expect(await inspect.getJob(scanId)).toBeTruthy()
    expect(await api.enqueueScan(data)).toBe(scanId)
    expect((await inspect.getRanges(["wait"], 0, -1)).filter((id) => id === scanId)).toHaveLength(1)
    const job = await inspect.getJob(scanId)
    await job?.remove()
  }, 15_000)

  it("rejects an unavailable connection within deadline and sends no deferred job after recovery", async () => {
    setBlackhole(true)
    const proposal = `producer-fixture-${randomUUID()}`
    const started = Date.now()
    await expect(
      api.enqueueFixGenerate({ workspaceId: "fixture", fixProposalId: proposal })
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5_500)
    setBlackhole(false)
    const fixes = new Queue("fix-generate", {
      connection: { url: backendUrl, maxRetriesPerRequest: 1 },
    })
    expect(await fixes.getJob(proposal)).toBeUndefined()
    const recoveredId = `producer-fixture-${randomUUID()}`
    expect(
      await api.enqueueFixGenerate({ workspaceId: "fixture", fixProposalId: recoveredId })
    ).toBe(recoveredId)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await fixes.getJob(proposal)).toBeUndefined()
    await (await fixes.getJob(recoveredId))?.remove()
    await fixes.close()
  }, 10_000)

  it("executes successive webhook generations while retaining previous completed jobs", async () => {
    const event = `producer-fixture-${randomUUID()}`
    const seen: number[] = []
    const worker = new Worker(
      "webhook-track-retry",
      async (job) => {
        seen.push(job.data.generation)
      },
      {
        connection: { url: backendUrl, maxRetriesPerRequest: null },
        prefix: fixturePrefix,
        drainDelay: 600,
        stalledInterval: 120_000,
      }
    )
    const completed = () =>
      new Promise<void>((resolve) => worker.once("completed", () => resolve()))
    try {
      for (const generation of [1, 2, 3]) {
        const done = completed()
        const id = await api.enqueueWebhookTrackRetry({
          webhookEventId: event,
          track: "billing",
          generation,
        })
        expect(id).not.toContain(":")
        await done
      }
      expect(seen).toEqual([1, 2, 3])
      const queue = api.getWebhookTrackRetryQueue()
      for (const generation of [1, 2, 3]) {
        const job = await queue.getJob(
          api.webhookTrackRetryJobId({ webhookEventId: event, track: "billing", generation })
        )
        expect(await job?.getState()).toBe("completed")
        await job?.remove()
      }
    } finally {
      await worker.close()
    }
  }, 15_000)

  it("bounds the shared readiness blackhole and admits only a fresh request after recovery", async () => {
    setBlackhole(true)
    const scanId = `producer-fixture-${randomUUID()}`
    const data = {
      scanId,
      workspaceId: "fixture",
      targetId: "fixture",
      goal: "fixture",
      mode: "SAFE" as const,
    }
    const started = Date.now()
    try {
      await expect(api.enqueueScan(data)).rejects.toThrow("No scan worker")
      expect(Date.now() - started).toBeLessThan(5_500)
    } finally {
      setBlackhole(false)
    }
    const freshId = `producer-fixture-${randomUUID()}`
    expect(await api.enqueueScan({ ...data, scanId: freshId })).toBe(freshId)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await inspect.getJob(scanId)).toBeUndefined()
    await (await inspect.getJob(freshId))?.remove()
  }, 10_000)
})
