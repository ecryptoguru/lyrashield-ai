import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Output } from "../output.js"
import { handleGate } from "../commands/gate.js"
import { getEffectiveCredentials } from "../credentials.js"
import { loadDefaultProject } from "../projects.js"
import { listAll } from "@lyrashield/sdk"
import { runDiffChecks } from "../diff-core.js"

vi.mock("../client.js", () => ({ createClient: vi.fn() }))
vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(),
  requireWorkspace: vi.fn((creds: { workspaceId: string }) => creds.workspaceId),
}))
vi.mock("../projects.js", () => ({
  loadDefaultProject: vi.fn(),
  saveDefaultProject: vi.fn(),
}))
vi.mock("@lyrashield/sdk", () => ({ listAll: vi.fn(), FindingSchema: {} }))
vi.mock("../diff-core.js", () => ({
  resolveDiffRange: vi.fn(() => ({ base: "HEAD~1", head: "HEAD" })),
  runDiffChecks: vi.fn(async () => []),
  buildSarif: vi.fn(() => ({})),
  rankSeverity: (severity: string) =>
    ({ CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 })[severity.toUpperCase()] ?? 0,
}))

const mockGetEffectiveCredentials = vi.mocked(getEffectiveCredentials)
const mockLoadDefaultProject = vi.mocked(loadDefaultProject)
const mockListAll = vi.mocked(listAll)
const mockRunDiffChecks = vi.mocked(runDiffChecks)

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

describe("handleGate target scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunDiffChecks.mockResolvedValue([])
    mockGetEffectiveCredentials.mockResolvedValue({
      apiKey: "lsk_test",
      workspaceId: "ws-1",
    } as never)
  })

  it("passes targetId from --target to the findings query", async () => {
    mockListAll.mockResolvedValue([] as never)

    await handleGate(["--target", "target-42"], makeOutput())

    expect(mockListAll).toHaveBeenCalledTimes(1)
    const url = mockListAll.mock.calls[0]?.[2]
    expect(url).toContain("workspaceId=ws-1")
    expect(url).toContain("targetId=target-42")
    expect(url).toContain("status=OPEN")
  })

  it("falls back to the saved default project when it belongs to this workspace", async () => {
    mockLoadDefaultProject.mockResolvedValue({
      workspaceId: "ws-1",
      targetId: "target-default",
    } as never)
    mockListAll.mockResolvedValue([] as never)

    await handleGate([], makeOutput())

    const url = mockListAll.mock.calls[0]?.[2]
    expect(url).toContain("targetId=target-default")
  })

  it("ignores a saved default from another workspace and evaluates only diff checks", async () => {
    mockLoadDefaultProject.mockResolvedValue({
      workspaceId: "ws-other",
      targetId: "target-other",
    } as never)

    const output = makeOutput()
    await handleGate([], output)

    expect(mockListAll).not.toHaveBeenCalled()
    expect(output.notice).toHaveBeenCalledWith(expect.stringContaining("local diff checks only"))
  })

  it("never queries without a targetId filter", async () => {
    mockListAll.mockResolvedValue([] as never)

    await handleGate(["--target", "t-1"], makeOutput())

    for (const call of mockListAll.mock.calls) {
      expect(call[2]).toContain("targetId=")
    }
  })

  it("fails closed on incomplete WebMCP coverage above the selected severity threshold", async () => {
    mockGetEffectiveCredentials.mockResolvedValue({} as never)
    mockRunDiffChecks.mockResolvedValue([
      {
        ruleId: "WEBMCP-COVERAGE-INCOMPLETE",
        level: "error",
        severity: "HIGH",
        message: "WebMCP diff coverage incomplete: max_total_bytes",
        coverageIncomplete: true,
      },
    ])

    const output = makeOutput()
    const exitCode = await handleGate(["--fail-on", "CRITICAL"], output)

    expect(exitCode).toBe(1)
    expect(output.error).toHaveBeenCalledWith("Gate failed: WebMCP diff coverage was incomplete", 1)
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("WEBMCP-COVERAGE-INCOMPLETE"))
  })
})

describe("handleGate --verdict (WP5 launch-gate verdict)", () => {
  function mockClientWithVerdict(state: string, extra: Record<string, unknown> = {}) {
    return vi.fn(async () => ({
      state,
      blockingReasons: [],
      nonCoverage: [],
      staleness: { current: true, reason: null },
      standardVersion: "lyrashield-gate/1.0.0",
      ...extra,
    }))

  }

  it("exits 0 when the gate verdict is READY", async () => {
    mockGetEffectiveCredentials.mockResolvedValue({ apiKey: "k", workspaceId: "ws-1" } as never)
    const request = mockClientWithVerdict("READY")
    const { createClient } = await import("../client.js")
    vi.mocked(createClient).mockResolvedValue({ request } as never)

    const output = makeOutput()
    const exitCode = await handleGate(["--verdict", "--target", "t-1"], output)

    expect(exitCode).toBe(0)
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("READY"))
  })

  it("exits 1 when the gate verdict is NOT_READY", async () => {
    mockGetEffectiveCredentials.mockResolvedValue({ apiKey: "k", workspaceId: "ws-1" } as never)
    const request = mockClientWithVerdict("NOT_READY", { blockingReasons: [{ findingId: "f1" }] })
    const { createClient } = await import("../client.js")
    vi.mocked(createClient).mockResolvedValue({ request } as never)

    const output = makeOutput()
    const exitCode = await handleGate(["--verdict", "--target", "t-1"], output)

    expect(exitCode).toBe(1)
  })

  it("exits 2 when evidence is insufficient or the call errors", async () => {
    mockGetEffectiveCredentials.mockResolvedValue({ apiKey: "k", workspaceId: "ws-1" } as never)
    const request = mockClientWithVerdict("INSUFFICIENT_EVIDENCE")
    const { createClient } = await import("../client.js")
    vi.mocked(createClient).mockResolvedValue({ request } as never)

    const output = makeOutput()
    const exitCode = await handleGate(["--verdict", "--target", "t-1"], output)

    expect(exitCode).toBe(2)
  })

  it("exits 2 without an API key (login required)", async () => {
    mockGetEffectiveCredentials.mockResolvedValue({ workspaceId: "ws-1" } as never)
    const output = makeOutput()
    const exitCode = await handleGate(["--verdict", "--target", "t-1"], output)
    expect(exitCode).toBe(2)
  })
})
