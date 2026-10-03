import { describe, expect, it, vi } from "vitest"
import { assertWorkerDbPoolCapacity, observeWorkerRun } from "./worker-lifecycle"

describe("assertWorkerDbPoolCapacity", () => {
  it("allows scan concurrency below the database connection pool size", () => {
    expect(() => assertWorkerDbPoolCapacity(3, 4)).not.toThrow()
  })

  it("rejects scan concurrency that can occupy every database connection", () => {
    expect(() => assertWorkerDbPoolCapacity(4, 4)).toThrow(
      "Total worker concurrency (4 scan + 0 auxiliary = 4) must be lower than LYRASHIELD_DB_POOL_MAX (4)"
    )
  })

  it("counts retry and fix-generation jobs before reserving a finalization connection", () => {
    expect(() => assertWorkerDbPoolCapacity(3, 7, 4)).toThrow(
      "Total worker concurrency (3 scan + 4 auxiliary = 7) must be lower than LYRASHIELD_DB_POOL_MAX (7)"
    )
    expect(() => assertWorkerDbPoolCapacity(3, 8, 4)).not.toThrow()
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
