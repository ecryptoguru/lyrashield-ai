import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Output } from "../output.js"
import { handleGate } from "../commands/gate.js"
import { getEffectiveCredentials } from "../credentials.js"
import { loadDefaultProject } from "../projects.js"
import { listAll } from "@lyrashield/sdk"

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
  runRiskyPatternChecks: vi.fn(async () => []),
  buildSarif: vi.fn(() => ({})),
  rankSeverity: (severity: string) =>
    ({ CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 })[severity.toUpperCase()] ?? 0,
}))

const mockGetEffectiveCredentials = vi.mocked(getEffectiveCredentials)
const mockLoadDefaultProject = vi.mocked(loadDefaultProject)
const mockListAll = vi.mocked(listAll)

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
})
