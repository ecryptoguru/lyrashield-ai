import { describe, expect, it, vi } from "vitest"
import { assertWorkerDbPoolCapacity, observeWorkerRun } from "./worker-lifecycle"

describe("assertWorkerDbPoolCapacity", () => {
  it("allows scan concurrency below the database connection pool size", () => {
    expect(() => assertWorkerDbPoolCapacity(3, 4)).not.toThrow()
  })

  it("rejects scan concurrency that can occupy every database connection", () => {
    expect(() => assertWorkerDbPoolCapacity(4, 4)).toThrow(
      "LYRASHIELD_WORKER_CONCURRENCY (4) must be lower than LYRASHIELD_DB_POOL_MAX (4)"
    )
  })
})

describe("observeWorkerRun", () => {
  it("stops the process when the BullMQ run loop returns", async () => {
    const onUnexpectedStop = vi.fn()

    observeWorkerRun(Promise.resolve(), onUnexpectedStop)
    await Promise.resolve()

    expect(onUnexpectedStop).toHaveBeenCalledWith({ reason: "BULLMQ_RUN_RETURNED" })
  })

  it("stops the process when the BullMQ run loop rejects", async () => {
    const onUnexpectedStop = vi.fn()
    const error = new Error("Redis connection lost")

    observeWorkerRun(Promise.reject(error), onUnexpectedStop)
    await Promise.resolve()

    expect(onUnexpectedStop).toHaveBeenCalledWith({ reason: "BULLMQ_RUN_FAILURE", error })
  })
})
