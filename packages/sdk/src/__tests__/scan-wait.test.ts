import { afterEach, describe, expect, it, vi } from "vitest"
import { LyraShieldClient } from "../client"
import { waitForScan } from "../resources/scan-wait"

const scan = (status: string) => ({
  id: "scan-1",
  goal: "TEST_APP",
  mode: "STANDARD",
  status,
  createdAt: "2026-09-26T00:00:00.000Z",
})

afterEach(() => vi.useRealTimers())

describe("waitForScan", () => {
  it("polls an existing scan and returns its terminal state without submitting work", async () => {
    vi.useFakeTimers()
    const statuses = ["QUEUED", "COMPLETED"]
    const fetchFn = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.method).toBe("GET")
      return new Response(JSON.stringify({ success: true, data: scan(statuses.shift()!) }), {
        headers: { "Content-Type": "application/json" },
      })
    })
    const client = new LyraShieldClient({ apiKey: "synthetic", fetchFn })
    const onProgress = vi.fn()
    const result = waitForScan(client, "scan-1", { pollIntervalMs: 1_000, onProgress })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toMatchObject({ status: "COMPLETED" })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenCalledTimes(2)
  })

  it("does not contact the server after the user stops waiting", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn()
    const client = new LyraShieldClient({ apiKey: "synthetic", fetchFn })
    await expect(
      waitForScan(client, "scan-1", { signal: controller.signal })
    ).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("stops polling after interruption without cancelling the scan", async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: scan("QUEUED") }), {
          headers: { "Content-Type": "application/json" },
        })
    )
    const client = new LyraShieldClient({ apiKey: "synthetic", fetchFn })
    await expect(
      waitForScan(client, "scan-1", {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
    ).rejects.toMatchObject({ code: "REQUEST_ABORTED" })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"])(
    "returns the recorded %s terminal result",
    async (status) => {
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: scan(status) }), {
            headers: { "Content-Type": "application/json" },
          })
      )
      const client = new LyraShieldClient({ apiKey: "synthetic", fetchFn })
      await expect(waitForScan(client, "scan-1")).resolves.toMatchObject({ status })
    }
  )
})
