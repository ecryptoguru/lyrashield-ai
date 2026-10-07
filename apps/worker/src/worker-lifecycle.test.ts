import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolveDbPoolMax } from "../../../packages/db/src/pool"
import {
  assertWorkerDbPoolCapacity,
  observeWorkerRun,
  WEBHOOK_TRACK_RETRY_WORKER_CONCURRENCY,
  FIX_GENERATE_WORKER_CONCURRENCY,
} from "./worker-lifecycle"

describe("assertWorkerDbPoolCapacity", () => {
  it("starts with the deployed worker concurrency and default DB pool", () => {
    const workerEnv = readFileSync(
      new URL("../../../ops/worker/worker-env.sh", import.meta.url),
      "utf8"
    )
    const configuredScanConcurrency = workerEnv.match(/"--env LYRASHIELD_WORKER_CONCURRENCY=(\d+)"/)
    expect(configuredScanConcurrency).not.toBeNull()
    const scanConcurrency = Number(configuredScanConcurrency?.[1])
    const dbPoolMax = resolveDbPoolMax({})
    const auxiliaryConcurrency =
      WEBHOOK_TRACK_RETRY_WORKER_CONCURRENCY + FIX_GENERATE_WORKER_CONCURRENCY

    expect(scanConcurrency + auxiliaryConcurrency).toBeLessThan(dbPoolMax)
    expect(() =>
      assertWorkerDbPoolCapacity(scanConcurrency, dbPoolMax, auxiliaryConcurrency)
    ).not.toThrow()
    expect(() => assertWorkerDbPoolCapacity(scanConcurrency, dbPoolMax, 4)).toThrow(
      "must be lower than LYRASHIELD_DB_POOL_MAX (4)"
    )
  })

  it("allows scan concurrency below the database connection pool size", () => {
    expect(() => assertWorkerDbPoolCapacity(3, 4)).not.toThrow()
  })

  it("rejects scan concurrency that can occupy every database connection", () => {
    expect(() => assertWorkerDbPoolCapacity(4, 4)).toThrow(
      "Total worker concurrency (4 scan + 0 auxiliary = 4) must be lower than LYRASHIELD_DB_POOL_MAX (4)"
    )
  })

  it("fails closed if scan concurrency rises to three with both auxiliary workers", () => {
    const auxiliaryConcurrency =
      WEBHOOK_TRACK_RETRY_WORKER_CONCURRENCY + FIX_GENERATE_WORKER_CONCURRENCY
    expect(() => assertWorkerDbPoolCapacity(3, resolveDbPoolMax({}), auxiliaryConcurrency)).toThrow(
      "Total worker concurrency (3 scan + 2 auxiliary = 5) must be lower"
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
