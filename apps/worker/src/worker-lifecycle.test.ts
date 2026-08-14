import { describe, expect, it, vi } from "vitest"
import { observeWorkerRun } from "./worker-lifecycle"

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
