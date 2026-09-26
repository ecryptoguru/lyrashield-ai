import { describe, it, expect, vi, beforeEach } from "vitest"
import { LyraShieldClient } from "@lyrashield/sdk"
import type { Output } from "../output.js"
import { handlePreflight } from "../commands/preflight.js"
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

const ELIGIBLE = {
  allowed: true,
  code: null,
  message: null,
  plan: "PRO",
  isTrial: false,
  remainingMinutes: 120,
}

const DENIED = {
  allowed: false,
  code: "NO_MINUTES_REMAINING",
  message: "Your agent-minute balance is exhausted.",
  plan: "FREE",
  isTrial: false,
  remainingMinutes: 0,
  blockers: [{ code: "NO_MINUTES_REMAINING", message: "Your agent-minute balance is exhausted." }],
}

let mockFetch: ReturnType<typeof vi.fn>

function apiResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response
}

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

function lastRequestUrl(): URL {
  const call = mockFetch.mock.calls.at(-1) as [string] | undefined
  expect(call).toBeTruthy()
  return new URL(call![0])
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch = vi.fn().mockResolvedValue(apiResponse({ success: true, data: ELIGIBLE }))
  ;(getEffectiveCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
    apiKey: "lsk_test",
    workspaceId: "ws-current",
    apiUrl: "http://api.test",
  })
  ;(createClient as ReturnType<typeof vi.fn>).mockReturnValue(
    new LyraShieldClient({
      apiKey: "lsk_test",
      apiUrl: "http://api.test",
      workspaceId: "ws-current",
      fetchFn: mockFetch as unknown as typeof fetch,
    })
  )
  ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(null)
})

describe("handlePreflight", () => {
  it("issues GET /scans/eligibility with the normalized request and exits 0 when allowed", async () => {
    const output = makeOutput()
    const code = await handlePreflight(
      ["--target", "t-1", "--goal", "TEST_APP", "--mode", "STANDARD"],
      output
    )

    expect(code).toBe(0)
    const url = lastRequestUrl()
    expect(url.pathname).toBe("/api/v1/scans/eligibility")
    expect(url.searchParams.get("workspaceId")).toBe("ws-current")
    expect(url.searchParams.get("targetId")).toBe("t-1")
    expect(url.searchParams.get("goal")).toBe("TEST_APP")
    expect(url.searchParams.get("mode")).toBe("STANDARD")
  })

  it("returns exit 1 for a parsed eligibility denial — a successful read, not a failure", async () => {
    mockFetch.mockResolvedValue(apiResponse({ success: true, data: DENIED }))
    const output = makeOutput()

    const code = await handlePreflight(["--target", "t-1"], output)

    expect(code).toBe(1)
    expect(output.error).not.toHaveBeenCalled()
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("NO_MINUTES_REMAINING"))
    expect(output.log).toHaveBeenCalledWith("Blockers:")
  })

  it("prints the full response in --json mode for both verdicts", async () => {
    const output = makeOutput(true)
    expect(await handlePreflight(["--target", "t-1"], output)).toBe(0)
    expect(output.result).toHaveBeenCalledWith(ELIGIBLE)

    mockFetch.mockResolvedValue(apiResponse({ success: true, data: DENIED }))
    expect(await handlePreflight(["--target", "t-1"], output)).toBe(1)
    expect(output.result).toHaveBeenCalledWith(DENIED)
  })

  it("forwards workflow refs and repeated attachment ids", async () => {
    const output = makeOutput()
    const code = await handlePreflight(
      [
        "--target",
        "t-1",
        "--workflow",
        "REVIEW_CHANGES",
        "--base",
        "main",
        "--head",
        "feature/x",
        "--attachment",
        "att_1",
        "--attachment",
        "att_2",
      ],
      output
    )

    expect(code).toBe(0)
    const params = lastRequestUrl().searchParams
    expect(params.get("workflow")).toBe("REVIEW_CHANGES")
    expect(params.get("baseRef")).toBe("main")
    expect(params.get("headRef")).toBe("feature/x")
    expect(params.getAll("attachmentIds")).toEqual(["att_1", "att_2"])
  })

  it("rejects invalid workflow/ref combinations with exit 2 before any request", async () => {
    const output = makeOutput()
    expect(await handlePreflight(["--target", "t-1", "--base", "main"], output)).toBe(2)
    expect(await handlePreflight(["--target", "t-1", "--workflow", "REVIEW_CHANGES"], output)).toBe(
      2
    )
    expect(await handlePreflight(["--target", "t-1", "--workflow", "BOGUS"], output)).toBe(2)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects invalid goal/mode with exit 2 before any request", async () => {
    const output = makeOutput()
    expect(await handlePreflight(["--target", "t-1", "--mode", "MASSIVE"], output)).toBe(2)
    expect(await handlePreflight(["--target", "t-1", "--goal", "NOPE"], output)).toBe(2)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("uses --workspace override and the stored default project when --target is absent", async () => {
    ;(loadDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: "ws-other",
      projectId: "p-1",
      targetId: "t-default",
      repoFullName: "o/r",
    })
    const output = makeOutput()

    expect(await handlePreflight(["--workspace", "ws-other"], output)).toBe(0)
    const params = lastRequestUrl().searchParams
    expect(params.get("workspaceId")).toBe("ws-other")
    expect(params.get("targetId")).toBe("t-default")
  })

  it("requires a target when no flag or saved default applies", async () => {
    const output = makeOutput()
    expect(await handlePreflight([], output)).toBe(2)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("maps transport failures through the shared failure table", async () => {
    const { LyraShieldError } = await import("@lyrashield/sdk")

    for (const [status, exitCode] of [
      [401, 3],
      [403, 3],
      [429, 5],
      [402, 6],
      [500, 4],
    ] as const) {
      mockFetch.mockResolvedValue(
        apiResponse({ success: false, error: { code: "X", message: "denied by status" } }, status)
      )
      const output = makeOutput()
      expect(await handlePreflight(["--target", "t-1"], output)).toBe(exitCode)
    }

    mockFetch.mockRejectedValue(
      new LyraShieldError({ message: "boom", status: 0, code: "NETWORK_ERROR" })
    )
    const output = makeOutput()
    expect(await handlePreflight(["--target", "t-1"], output)).toBe(4)
  })
})
