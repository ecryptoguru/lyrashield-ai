import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Output } from "../output.js"
import { handleScan } from "../commands/scan.js"
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

function makeOutput(): Output {
  return {
    json: false,
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
  id: "s-9",
  workspaceId: "ws-current",
  goal: "TEST_APP",
  mode: "STANDARD",
  status: "QUEUED",
  createdAt: "2026-09-25T00:00:00.000Z",
}

let client: { request: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  ;(getEffectiveCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiKey: "lsk_test",
    workspaceId: "ws-current",
    apiUrl: "https://app.lyrashieldai.com",
  })
  client = { request: vi.fn() }
  ;(createClient as ReturnType<typeof vi.fn>).mockReturnValue(client)
  ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("scan --scan-id resume", () => {
  it("resumes watching an existing scan without submitting another one", async () => {
    client.request.mockResolvedValueOnce({ ...SCAN_QUEUED, status: "COMPLETED" })
    const output = makeOutput()
    const code = await handleScan(["--scan-id", "s-9", "--wait"], output)
    expect(code).toBe(0)
    // Only the poll — never a POST /scans submission.
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(client.request.mock.calls[0]?.[0]).toBe("GET")
    expect(client.request.mock.calls[0]?.[1]).toBe("/scans/s-9?workspaceId=ws-current")
  })

  it.each([
    ["--target", "t-1"],
    ["--repo", "owner/repo"],
    ["--base", "main"],
    ["--head", "feat"],
    ["--name", "x"],
    ["--attachment", "att_1"],
  ])("rejects --scan-id with new-scan-only input %s", async (flag, value) => {
    const output = makeOutput()
    const code = await handleScan(["--scan-id", "s-9", "--wait", flag, value], output)
    expect(code).toBe(2)
    expect(client.request).not.toHaveBeenCalled()
  })

  it("rejects --scan-id with a positional target", async () => {
    const output = makeOutput()
    const code = await handleScan(["--scan-id", "s-9", "t-1", "--wait"], output)
    expect(code).toBe(2)
    expect(client.request).not.toHaveBeenCalled()
  })

  it("rejects --scan-id with --auto", async () => {
    const output = makeOutput()
    const code = await handleScan(["--scan-id", "s-9", "--auto", "--wait"], output)
    expect(code).toBe(2)
    expect(client.request).not.toHaveBeenCalled()
  })

  it("still requires --sarif or --wait when --scan-id is given alone", async () => {
    const output = makeOutput()
    const code = await handleScan(["--scan-id", "s-9"], output)
    expect(code).toBe(2)
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("--sarif"))
    expect(client.request).not.toHaveBeenCalled()
  })
})
