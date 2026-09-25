import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { LyraShieldError } from "@lyrashield/sdk"
import type { Output } from "../output.js"
import { handleScan } from "../commands/scan.js"
import { handleStatus } from "../commands/status.js"
import { handleCancel } from "../commands/cancel.js"
import { handlePrScan } from "../commands/pr-scan.js"
import { createClient } from "../client.js"
import { getEffectiveCredentials } from "../credentials.js"
import { loadDefaultProject } from "../projects.js"

vi.mock("../client.js", () => ({
  createClient: vi.fn(),
}))

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(),
  requireWorkspace: vi.fn((creds: { workspaceId: string }) => creds.workspaceId),
}))

vi.mock("../projects.js", () => ({
  findOrCreateRepoTarget: vi.fn(),
  resolveRepoFromPath: vi.fn(),
  loadDefaultProject: vi.fn(),
  saveDefaultProject: vi.fn(),
}))

function makeOutput(json = false): Output {
  return {
    json,
    quiet: false,
    log: vi.fn(),
    notice: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    result: vi.fn(),
    fail: vi.fn() as unknown as (error: string, exitCode?: number) => never,
  }
}

const SCAN_QUEUED = {
  id: "s-123",
  workspaceId: "ws-current",
  goal: "TEST_APP",
  mode: "STANDARD",
  status: "QUEUED",
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
}

function scanSnapshot(status: string, extra: Record<string, unknown> = {}) {
  return { ...SCAN_QUEUED, status, ...extra }
}

function operationStatus(status: string, resultLocation: string | null = null) {
  return {
    operationId: "op-1",
    status,
    reasonCode: null,
    resultLocation,
    recovery: status === "FAILED" ? "retry_new_key" : "poll",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  }
}

type RequestMock = ReturnType<typeof vi.fn>
function mockClient(): { request: RequestMock } {
  return { request: vi.fn() }
}

let client: { request: RequestMock }

beforeEach(() => {
  vi.clearAllMocks()
  ;(getEffectiveCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiKey: "lsk_test",
    workspaceId: "ws-current",
    apiUrl: "https://app.lyrashieldai.com",
  })
  client = mockClient()
  ;(createClient as ReturnType<typeof vi.fn>).mockReturnValue(client)
  ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("scan --wait", () => {
  it("follows the accepted scan to COMPLETED and exits 0", async () => {
    client.request
      .mockResolvedValueOnce({ id: "s-123", operationId: "op-1" })
      .mockResolvedValueOnce(scanSnapshot("RUNNING"))
      .mockResolvedValueOnce(scanSnapshot("COMPLETED"))

    const output = makeOutput()
    const code = await handleScan(["--target", "t-1", "--wait", "--poll-interval", "1"], output)

    expect(code).toBe(0)
    const pollPaths = client.request.mock.calls.map((c) => c[1])
    expect(pollPaths).toContain("/scans/s-123?workspaceId=ws-current")
    // Immediate acceptance notice with the resume hint on stderr.
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("accepted"))
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("status s-123 --watch"))
    const result = (output.result as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >
    expect(result).toMatchObject({
      scanId: "s-123",
      terminalStatus: "COMPLETED",
      operationId: "op-1",
      resumeCommand: "lyrashield status s-123 --watch",
    })
  })

  it("treats --watch as an alias of --wait", async () => {
    client.request
      .mockResolvedValueOnce({ id: "s-123" })
      .mockResolvedValueOnce(scanSnapshot("COMPLETED"))
    const output = makeOutput()
    expect(await handleScan(["--target", "t-1", "--watch"], output)).toBe(0)
  })

  it("pr-scan accepts --wait identically", async () => {
    client.request
      .mockResolvedValueOnce({ id: "s-123" })
      .mockResolvedValueOnce(scanSnapshot("COMPLETED"))
    const output = makeOutput()
    const code = await handlePrScan(["--target", "t-1", "--wait"], output)
    expect(code).toBe(0)
    expect(client.request.mock.calls[0]?.[2]?.body).toMatchObject({ goal: "CHECK_PR" })
  })

  it("exits 7 when the scan ends in a terminal state other than COMPLETED", async () => {
    client.request
      .mockResolvedValueOnce({ id: "s-123" })
      .mockResolvedValueOnce(scanSnapshot("FAILED"))
    const output = makeOutput()
    const code = await handleScan(["--target", "t-1", "--wait"], output)
    expect(code).toBe(7)
    expect((output.result as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      terminalStatus: "FAILED",
      scanId: "s-123",
    })
  })

  it("exits 8 when the wait deadline is reached", async () => {
    vi.useFakeTimers()
    client.request.mockResolvedValueOnce({ id: "s-123" }).mockResolvedValue(scanSnapshot("RUNNING"))
    const output = makeOutput()
    const outcome = handleScan(
      ["--target", "t-1", "--wait", "--timeout", "5", "--poll-interval", "1"],
      output
    )
    const assertion = outcome.then((code) => {
      expect(code).toBe(8)
      expect(output.error).toHaveBeenCalledWith(expect.stringContaining("s-123"), 8)
    })
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["0", "-5", "abc", "90000"])(
    "rejects --timeout %s before submitting a scan",
    async (timeout) => {
      const output = makeOutput()
      const code = await handleScan(["--target", "t-1", "--wait", "--timeout", timeout], output)
      expect(code).toBe(2)
      expect(client.request).not.toHaveBeenCalled()
    }
  )

  it("rejects --poll-interval below 1s before submitting", async () => {
    const output = makeOutput()
    const code = await handleScan(["--target", "t-1", "--wait", "--poll-interval", "0.5"], output)
    expect(code).toBe(2)
    expect(client.request).not.toHaveBeenCalled()
  })

  it("rejects --timeout without --wait", async () => {
    const output = makeOutput()
    const code = await handleScan(["--target", "t-1", "--timeout", "60"], output)
    expect(code).toBe(2)
    expect(client.request).not.toHaveBeenCalled()
  })

  it("follows the durable operation on OPERATION_IN_PROGRESS instead of resubmitting", async () => {
    const conflict = new LyraShieldError({
      status: 409,
      code: "OPERATION_IN_PROGRESS",
      message: "An identical scan start is already in progress.",
      details: { operationId: "op-7" },
    })
    client.request
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(operationStatus("COMPLETED", "s-123"))
      .mockResolvedValueOnce(scanSnapshot("COMPLETED"))
    const output = makeOutput()
    const code = await handleScan(
      ["--target", "t-1", "--wait", "--poll-interval", "1", "--idempotency-key", "same-key"],
      output
    )
    expect(code).toBe(0)
    const posts = client.request.mock.calls.filter((c) => c[0] === "POST")
    expect(posts).toHaveLength(1)
    expect(client.request.mock.calls.map((c) => c[1])).toContain(
      "/agent-operations/op-7?workspaceId=ws-current"
    )
    expect((output.result as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      scanId: "s-123",
      operationId: "op-7",
    })
  })

  it("surfaces the operation id on a 409 submission without --wait", async () => {
    const conflict = new LyraShieldError({
      status: 409,
      code: "OPERATION_FAILED",
      message: "This operation previously failed.",
      details: { operationId: "op-8" },
    })
    client.request.mockRejectedValueOnce(conflict)
    const output = makeOutput()
    const code = await handleScan(["--target", "t-1"], output)
    expect(code).toBe(4)
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("status --operation op-8 --watch"),
      4
    )
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  it("--json keeps wait progress on stderr and stdout to a single final document", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      client.request
        .mockResolvedValueOnce({ id: "s-123", operationId: "op-1" })
        .mockResolvedValueOnce(scanSnapshot("COMPLETED"))
      const output = makeOutput(true)
      const code = await handleScan(["--target", "t-1", "--wait"], output)
      expect(code).toBe(0)
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("accepted"))
      // Human-mode notices are suppressed in json mode; the only output is the
      // single final result document.
      expect(output.notice).not.toHaveBeenCalled()
      expect(output.result).toHaveBeenCalledTimes(1)
      expect((output.result as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
        terminalStatus: "COMPLETED",
        scanId: "s-123",
      })
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("SIGINT during the wait exits 130 and prints the resume hint", async () => {
    client.request
      .mockResolvedValueOnce({ id: "s-123" })
      .mockImplementation(async () => scanSnapshot("RUNNING"))
    const output = makeOutput()
    const before = process.listeners("SIGINT")
    const outcome = handleScan(["--target", "t-1", "--wait"], output)
    await vi.waitFor(() => {
      expect(client.request.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    const added = process.listeners("SIGINT").find((l) => !before.includes(l))
    expect(added).toBeDefined()
    ;(added as () => void)()
    const code = await outcome
    expect(code).toBe(130)
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("status s-123 --watch"), 130)
    // The SIGINT listener is removed once the wait ends.
    expect(process.listeners("SIGINT")).not.toContain(added)
  })
})

describe("status --watch", () => {
  it("waits on an existing scan to terminal", async () => {
    client.request
      .mockResolvedValueOnce(scanSnapshot("RUNNING"))
      .mockResolvedValueOnce(scanSnapshot("COMPLETED"))
    const output = makeOutput()
    const code = await handleStatus(["s-123", "--watch", "--poll-interval", "1"], output)
    expect(code).toBe(0)
    expect(client.request.mock.calls.map((c) => c[1])).toEqual([
      "/scans/s-123?workspaceId=ws-current",
      "/scans/s-123?workspaceId=ws-current",
    ])
  })

  it("exits 7 for a CANCELLED scan", async () => {
    client.request.mockResolvedValueOnce(scanSnapshot("CANCELLED"))
    const output = makeOutput()
    expect(await handleStatus(["s-123", "--watch"], output)).toBe(7)
  })

  it("requires a scan id or --operation with --watch", async () => {
    const output = makeOutput()
    expect(await handleStatus(["--watch"], output)).toBe(2)
    expect(client.request).not.toHaveBeenCalled()
  })

  it("keeps non-watch behavior unchanged", async () => {
    client.request.mockResolvedValueOnce(scanSnapshot("RUNNING"))
    const output = makeOutput()
    expect(await handleStatus(["s-123"], output)).toBe(0)
    expect(output.result).toHaveBeenCalledWith(scanSnapshot("RUNNING"))
  })
})

describe("status --operation --watch", () => {
  it("follows a completed operation's internal scan reference", async () => {
    client.request
      .mockResolvedValueOnce(operationStatus("EXECUTING"))
      .mockResolvedValueOnce(operationStatus("COMPLETED", "s-123"))
      .mockResolvedValueOnce(scanSnapshot("COMPLETED"))
    const output = makeOutput()
    const code = await handleStatus(
      ["--operation", "op-1", "--watch", "--poll-interval", "1"],
      output
    )
    expect(code).toBe(0)
    const paths = client.request.mock.calls.map((c) => c[1])
    expect(paths[0]).toBe("/agent-operations/op-1?workspaceId=ws-current")
    expect(paths[2]).toBe("/scans/s-123?workspaceId=ws-current")
    expect((output.result as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      scanId: "s-123",
      terminalStatus: "COMPLETED",
      operationId: "op-1",
    })
  })

  it("reports FAILED operations with retry guidance and exits 7", async () => {
    client.request.mockResolvedValueOnce(operationStatus("FAILED", null))
    const output = makeOutput()
    const code = await handleStatus(["--operation", "op-1", "--watch"], output)
    expect(code).toBe(7)
    expect((output.result as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      terminalStatus: "FAILED",
      operationId: "op-1",
    })
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("new idempotency key"))
  })

  it("does not follow a non-scan resultLocation like a URL", async () => {
    client.request.mockResolvedValueOnce(
      operationStatus("COMPLETED", "https://example.com/results/x")
    )
    const output = makeOutput()
    const code = await handleStatus(["--operation", "op-1", "--watch"], output)
    expect(code).toBe(0)
    expect(client.request).toHaveBeenCalledTimes(1)
    expect((output.result as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      terminalStatus: "COMPLETED",
      operationId: "op-1",
    })
  })
})

describe("cancel", () => {
  it("cancels a scan via POST and exits 0", async () => {
    client.request.mockResolvedValueOnce({ id: "s-123", status: "CANCELLED" })
    const output = makeOutput()
    const code = await handleCancel(["s-123", "--idempotency-key", "k-9"], output)
    expect(code).toBe(0)
    expect(client.request).toHaveBeenCalledWith(
      "POST",
      "/scans/s-123",
      expect.objectContaining({
        body: { workspaceId: "ws-current" },
        headers: { "Idempotency-Key": "k-9" },
      })
    )
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("status s-123"))
  })

  it("requires a scan id", async () => {
    const output = makeOutput()
    expect(await handleCancel([], output)).toBe(2)
    expect(client.request).not.toHaveBeenCalled()
  })

  it("re-reads a 409 conflict and exits 0 when already CANCELLED", async () => {
    const conflict = new LyraShieldError({
      status: 409,
      code: "SCAN_ALREADY_FINISHED",
      message: "Scan already finished",
    })
    client.request.mockRejectedValueOnce(conflict).mockResolvedValueOnce(scanSnapshot("CANCELLED"))
    const output = makeOutput()
    const code = await handleCancel(["s-123"], output)
    expect(code).toBe(0)
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("already cancelled"))
  })

  it("re-reads a 409 conflict and exits 1 when the scan is terminal otherwise", async () => {
    const conflict = new LyraShieldError({ status: 409, message: "conflict" })
    client.request.mockRejectedValueOnce(conflict).mockResolvedValueOnce(scanSnapshot("COMPLETED"))
    const output = makeOutput()
    const code = await handleCancel(["s-123"], output)
    expect(code).toBe(1)
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("COMPLETED"), 1)
  })

  it("maps API errors through the shared failure table", async () => {
    const denied = new LyraShieldError({ status: 403, message: "forbidden" })
    client.request.mockRejectedValueOnce(denied)
    const output = makeOutput()
    expect(await handleCancel(["s-123"], output)).toBe(3)
  })
})
