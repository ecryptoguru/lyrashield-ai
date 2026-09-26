import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleScan } from "../commands/scan.js"
import { handleStatus } from "../commands/status.js"
import type { Output } from "../output.js"
import { createClient } from "../client.js"
import { followScan } from "../scan-follow.js"
import { getOperationStatus } from "@lyrashield/sdk"

vi.mock("../client.js", () => ({ createClient: vi.fn() }))
vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }),
  requireWorkspace: vi.fn((value: { workspaceId: string }) => value.workspaceId),
}))
vi.mock("../scan-follow.js", () => ({
  followScan: vi.fn().mockResolvedValue(0),
  parseWaitTimeout: (value: unknown) => {
    if (value === undefined) return 1_800_000
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400
      ? seconds * 1_000
      : null
  },
}))
vi.mock("@lyrashield/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lyrashield/sdk")>()),
  getOperationStatus: vi.fn(),
}))

const output = {
  result: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  log: vi.fn(),
} as unknown as Output

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createClient).mockResolvedValue({
    request: vi.fn().mockResolvedValue({ id: "scan-1" }),
  } as never)
})

describe("CLI scan follow", () => {
  it("submits once, then follows the accepted scan ID", async () => {
    expect(await handleScan(["--target", "target-1", "--wait", "--timeout", "10"], output)).toBe(0)
    const client = await createClient()
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(followScan).toHaveBeenCalledWith(client, "scan-1", "ws-1", 10_000, output)
  })

  it("rejects an invalid deadline before target resolution or submission", async () => {
    expect(await handleScan(["--target", "target-1", "--wait", "--timeout", "0"], output)).toBe(2)
    expect(createClient).not.toHaveBeenCalled()
  })

  it("resumes an existing scan without submitting", async () => {
    expect(await handleStatus(["scan-1", "--watch"], output)).toBe(0)
    expect(followScan).toHaveBeenCalledWith(
      await createClient(),
      "scan-1",
      "ws-1",
      1_800_000,
      output
    )
    expect((await createClient()).request).not.toHaveBeenCalled()
  })

  it("follows only a validated scan-create operation reference", async () => {
    const scanId = `c${"a".repeat(24)}`
    vi.mocked(getOperationStatus).mockResolvedValue({
      operationId: "op-1",
      operationName: "scan.create",
      status: "COMPLETED",
      reasonCode: null,
      resultLocation: scanId,
      recovery: "none",
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z",
    })
    expect(await handleStatus(["--operation", "op-1", "--watch"], output)).toBe(0)
    expect(followScan).toHaveBeenCalledWith(
      await createClient(),
      scanId,
      "ws-1",
      expect.any(Number),
      output,
      "op-1"
    )
  })

  it("does not follow an arbitrary operation result URL", async () => {
    vi.mocked(getOperationStatus).mockResolvedValue({
      operationId: "op-1",
      operationName: "scan.create",
      status: "COMPLETED",
      reasonCode: null,
      resultLocation: "https://example.com/scan",
      recovery: "none",
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z",
    })
    expect(await handleStatus(["--operation", "op-1", "--watch"], output)).toBe(0)
    expect(followScan).not.toHaveBeenCalled()
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({ resultLocation: "https://example.com/scan" })
    )
  })
})
