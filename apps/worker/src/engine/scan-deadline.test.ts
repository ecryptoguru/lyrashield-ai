import { afterEach, describe, expect, it, vi } from "vitest"
import { boundedCleanup, scanElapsedClock } from "./scan-deadline"

afterEach(() => vi.useRealTimers())

describe("scan execution deadline", () => {
  it("retains persisted elapsed time and advances with monotonic time", () => {
    let tick = 50
    const elapsed = scanElapsedClock(new Date(1_000), 6_000, () => tick)
    expect(elapsed()).toBe(5_000)
    tick += 250
    expect(elapsed()).toBe(5_250)
  })

  it("starts fresh without a persisted timestamp and clamps clock skew", () => {
    expect(scanElapsedClock(null, 0, () => 1)()).toBe(0)
    expect(scanElapsedClock(new Date(10_000), 5_000, () => 1)()).toBe(0)
  })

  it("bounds uncooperative cleanup and consumes a later rejection", async () => {
    vi.useFakeTimers()
    let rejectWork!: (error: Error) => void
    const result = boundedCleanup(
      new Promise<void>((_, reject) => {
        rejectWork = reject
      }),
      50
    )
    const assertion = expect(result).rejects.toThrow("grace period")
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    rejectWork(new Error("late I/O failure"))
    await Promise.resolve()
  })
})
