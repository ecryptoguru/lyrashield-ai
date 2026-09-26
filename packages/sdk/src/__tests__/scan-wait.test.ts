import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { LyraShieldClient } from "../client"
import { LyraShieldError } from "../errors"
import { waitForScan, TERMINAL_SCAN_STATUSES, KNOWN_SCAN_STATUSES } from "../resources/scan-wait"

function makeFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch
}

function scanResponse(status: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({
      success: true,
      data: {
        id: "scan-1",
        workspaceId: "ws-1",
        goal: "TEST_APP",
        mode: "STANDARD",
        status,
        createdAt: "2026-09-25T00:00:00.000Z",
        updatedAt: "2026-09-25T00:00:00.000Z",
        ...extra,
      },
    }),
  }
}

function errorResponse(status: number, retryAfter?: string) {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
    json: async () => ({
      success: false,
      error: { code: `HTTP_${status}`, message: `status ${status}` },
    }),
    body: { cancel: async () => {} },
  }
}

let mockFetch: ReturnType<typeof vi.fn>
let client: LyraShieldClient

beforeEach(() => {
  mockFetch = vi.fn()
  client = new LyraShieldClient({
    apiKey: "test-key",
    apiUrl: "http://localhost:3000",
    workspaceId: "ws-1",
    fetchFn: makeFetch(mockFetch),
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("status wire lists", () => {
  it("mirrors the authoritative server terminal set exactly", () => {
    // Hardcoded from packages/db/src/scan-transitions.ts — a new server-side
    // terminal status must fail here loudly instead of silently spinning in a
    // wait loop or becoming a false success.
    expect([...TERMINAL_SCAN_STATUSES].sort()).toEqual(
      ["CANCELLED", "COMPLETED", "FAILED", "PARTIAL", "STOPPED_BUDGET", "TIMED_OUT"].sort()
    )
    expect(Object.isFrozen(TERMINAL_SCAN_STATUSES)).toBe(true)
  })

  it("knownStatuses covers every documented nonterminal and terminal state", () => {
    expect([...KNOWN_SCAN_STATUSES].sort()).toEqual(
      [
        "QUEUED",
        "PREFLIGHT",
        "RUNNING",
        "VERIFYING",
        "REQUIRES_APPROVAL",
        "CANCELLED",
        "COMPLETED",
        "FAILED",
        "PARTIAL",
        "STOPPED_BUDGET",
        "TIMED_OUT",
      ].sort()
    )
    expect(Object.isFrozen(KNOWN_SCAN_STATUSES)).toBe(true)
  })
})

describe("waitForScan", () => {
  it.each(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"])(
    "resolves with the final snapshot when the scan reaches %s",
    async (status) => {
      mockFetch.mockResolvedValueOnce(scanResponse(status))
      const result = await waitForScan(client, "scan-1")
      expect(result.status).toBe(status)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    }
  )

  it("keeps waiting through REQUIRES_APPROVAL", async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(scanResponse("REQUIRES_APPROVAL"))
      .mockResolvedValueOnce(scanResponse("COMPLETED"))
    const outcome = waitForScan(client, "scan-1", { pollIntervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await outcome
    expect(result.status).toBe("COMPLETED")
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("fires onProgress on the first snapshot and on each change only", async () => {
    vi.useFakeTimers()
    const onProgress = vi.fn()
    mockFetch
      .mockResolvedValueOnce(scanResponse("QUEUED"))
      .mockResolvedValueOnce(scanResponse("QUEUED"))
      .mockResolvedValueOnce(scanResponse("RUNNING", { updatedAt: "2026-09-25T00:00:05.000Z" }))
      .mockResolvedValueOnce(scanResponse("COMPLETED"))
    const outcome = waitForScan(client, "scan-1", {
      pollIntervalMs: 1000,
      onProgress,
    })
    await vi.advanceTimersByTimeAsync(3000)
    const result = await outcome
    expect(result.status).toBe("COMPLETED")
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress.mock.calls.map((call) => call[0].status)).toEqual([
      "QUEUED",
      "RUNNING",
      "COMPLETED",
    ])
  })

  it("treats a 304 NotModified as unchanged and keeps waiting", async () => {
    vi.useFakeTimers()
    const onProgress = vi.fn()
    mockFetch
      .mockResolvedValueOnce(scanResponse("RUNNING"))
      .mockResolvedValueOnce({
        ok: false,
        status: 304,
        statusText: "Not Modified",
        headers: new Headers({ etag: '"etag-1"' }),
        json: async () => ({}),
      })
      .mockResolvedValueOnce(scanResponse("COMPLETED"))
    const outcome = waitForScan(client, "scan-1", {
      pollIntervalMs: 1000,
      onProgress,
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect((await outcome).status).toBe("COMPLETED")
    // No progress event for the unchanged 304 poll.
    expect(onProgress.mock.calls.map((call) => call[0].status)).toEqual(["RUNNING", "COMPLETED"])
    // The server-supplied validator is echoed back on later polls.
    const lastInit = mockFetch.mock.calls[2]![1] as RequestInit
    expect((lastInit.headers as Record<string, string>)["If-None-Match"]).toBe('"etag-1"')
  })

  it("honors Retry-After after the client's own retries are exhausted", async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(errorResponse(429, "0"))
      .mockResolvedValueOnce(errorResponse(429, "0"))
      .mockResolvedValueOnce(errorResponse(429, "2"))
      .mockResolvedValueOnce(scanResponse("COMPLETED"))
    const outcome = waitForScan(client, "scan-1", { pollIntervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(60000)
    expect((await outcome).status).toBe("COMPLETED")
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it("propagates a 401 credential revocation instead of waiting forever", async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(scanResponse("RUNNING"))
      .mockResolvedValueOnce(errorResponse(401))
    const outcome = waitForScan(client, "scan-1", { pollIntervalMs: 1000 })
    const assertion = expect(outcome).rejects.toMatchObject({
      status: 401,
      code: "HTTP_401",
    })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it("throws SCAN_WAIT_TIMEOUT with the scan id and a resume hint at the deadline", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async () => scanResponse("RUNNING"))
    const outcome = waitForScan(client, "scan-1", {
      timeoutMs: 10_000,
      pollIntervalMs: 1000,
    })
    const assertion = expect(outcome).rejects.toMatchObject({
      code: "SCAN_WAIT_TIMEOUT",
      message: expect.stringContaining("scan-1"),
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    await outcome.catch((error: unknown) => {
      expect((error as Error).message).toContain("status scan-1 --watch")
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects with SCAN_WAIT_ABORTED and performs no fetch for a pre-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      waitForScan(client, "scan-1", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "SCAN_WAIT_ABORTED" })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects with SCAN_WAIT_ABORTED when the caller aborts during a poll sleep", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    mockFetch.mockImplementation(async () => scanResponse("RUNNING"))
    const outcome = waitForScan(client, "scan-1", {
      pollIntervalMs: 5000,
      signal: controller.signal,
    })
    const assertion = expect(outcome).rejects.toMatchObject({
      code: "SCAN_WAIT_ABORTED",
      message: expect.stringContaining("scan-1"),
    })
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects with SCAN_WAIT_ABORTED when the caller aborts mid-request", async () => {
    const controller = new AbortController()
    mockFetch.mockImplementation((_url: unknown, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        })
      })
    })
    const outcome = waitForScan(client, "scan-1", { signal: controller.signal })
    const assertion = expect(outcome).rejects.toMatchObject({ code: "SCAN_WAIT_ABORTED" })
    // The request resolves its token asynchronously first; wait until the
    // fetch is actually in flight so the abort lands mid-request.
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    controller.abort()
    await assertion
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it.each([0, -5, 999])(
    "rejects pollIntervalMs %i without touching the network",
    async (pollIntervalMs) => {
      await expect(waitForScan(client, "scan-1", { pollIntervalMs })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      })
      expect(mockFetch).not.toHaveBeenCalled()
    }
  )

  it.each([0, -1])("rejects timeoutMs %i without touching the network", async (timeoutMs) => {
    await expect(waitForScan(client, "scan-1", { timeoutMs })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("keeps waiting on an unrecognized status rather than exiting early", async () => {
    vi.useFakeTimers()
    mockFetch
      .mockResolvedValueOnce(scanResponse("FUTURE_STATUS_V2"))
      .mockResolvedValueOnce(scanResponse("COMPLETED"))
    const outcome = waitForScan(client, "scan-1", { pollIntervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect((await outcome).status).toBe("COMPLETED")
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("passes workspaceId through to the poll request", async () => {
    mockFetch.mockResolvedValueOnce(scanResponse("COMPLETED"))
    await waitForScan(client, "scan-1", { workspaceId: "ws-other" })
    expect(mockFetch.mock.calls[0]![0]).toBe(
      "http://localhost:3000/api/v1/scans/scan-1?workspaceId=ws-other"
    )
  })

  it("throws LyraShieldError instances (never bare errors) for wait failures", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async () => scanResponse("RUNNING"))
    const outcome = waitForScan(client, "scan-1", { timeoutMs: 2000, pollIntervalMs: 1000 })
    const assertion = expect(outcome).rejects.toBeInstanceOf(LyraShieldError)
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
  })
})
