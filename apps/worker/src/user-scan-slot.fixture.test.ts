import { describe, expect, it, vi } from "vitest"
import {
  assertUserScanSlotRedisFixture,
  withUserScanSlotQueueFixture,
} from "./user-scan-slot.fixture"

describe("user scan slot fixture safety", () => {
  it("rejects missing or malformed ownership before opening a Redis connection", async () => {
    for (const identity of [undefined, "", "localhost"]) {
      await expect(assertUserScanSlotRedisFixture("redis://127.0.0.1:1", identity)).rejects.toThrow(
        "requires explicit task-owned Redis fixture identity"
      )
    }
  })

  it("unregisters the worker even when exact-job removal fails", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("job removal failed"))
    const getJob = vi.fn().mockResolvedValue({ remove })
    const unregisterScanWorker = vi.fn().mockResolvedValue(undefined)
    const fixture = {
      registerScanWorker: vi.fn().mockResolvedValue(undefined),
      unregisterScanWorker,
      getScanQueue: () => ({ getJob }),
    }
    await expect(
      withUserScanSlotQueueFixture(fixture, "exact-worker", "exact-scan", async () => {
        throw new Error("assertion failed")
      })
    ).rejects.toThrow("job removal failed")
    expect(getJob).toHaveBeenCalledWith("exact-scan")
    expect(remove).toHaveBeenCalledOnce()
    expect(unregisterScanWorker).toHaveBeenCalledExactlyOnceWith("exact-worker")
  })
})
