import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const members = new Map<string, number>()
  const redis = {
    members,
    multi() {
      const commands: Array<() => number> = []
      const chain = {
        zremrangebyscore(_key: string, _min: string, max: number) {
          commands.push(() => {
            let removed = 0
            for (const [id, expiry] of members) {
              if (expiry <= Number(max)) {
                members.delete(id)
                removed += 1
              }
            }
            return removed
          })
          return chain
        },
        zadd(_key: string, score: number, member: string) {
          commands.push(() => {
            members.set(member, Number(score))
            return 1
          })
          return chain
        },
        pexpire() {
          commands.push(() => 1)
          return chain
        },
        zcard() {
          commands.push(() => members.size)
          return chain
        },
        exec: async () => commands.map((command) => [null, command()]),
      }
      return chain
    },
    async zrem(_key: string, member: string) {
      return members.delete(member) ? 1 : 0
    },
  }
  return { redis, queueAdd: vi.fn() }
})

vi.mock("./redis", () => ({ getRedis: () => mocks.redis }))
vi.mock("bullmq", () => ({
  Queue: class {
    add = mocks.queueAdd
  },
  QueueEvents: class {},
}))

import {
  enqueueScan,
  isScanWorkerAvailable,
  registerScanWorker,
  ScanWorkerUnavailableError,
  unregisterScanWorker,
} from "./queue"

describe("scan worker availability", () => {
  beforeEach(() => {
    mocks.redis.members.clear()
    mocks.queueAdd.mockReset()
  })

  it("supports multiple workers and expires stale heartbeats", async () => {
    await registerScanWorker("worker-1", 1_000)
    await registerScanWorker("worker-2", 2_000)

    expect(await isScanWorkerAvailable(20_000)).toBe(true)
    await unregisterScanWorker("worker-1")
    expect(await isScanWorkerAvailable(20_000)).toBe(true)
    expect(await isScanWorkerAvailable(40_000)).toBe(false)
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
})
