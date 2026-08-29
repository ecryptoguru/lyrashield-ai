import { beforeEach, describe, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { discoverWebMcpTools } from "@lyrashield/security/webmcp/discover"
import { runWebMcpDiffChecks } from "../diff-core.js"

vi.mock("node:child_process", () => ({ execFile: vi.fn() }))
vi.mock("@lyrashield/security/webmcp", () => ({
  evaluateWebMcpSurface: vi.fn(() => []),
  WEBMCP_CONTROLS_BY_ID: {},
}))
vi.mock("@lyrashield/security/webmcp/discover", () => ({ discoverWebMcpTools: vi.fn() }))

const mockExecFile = vi.mocked(execFile)
const mockDiscover = vi.mocked(discoverWebMcpTools)

function mockGit(files: string[], content: string): void {
  mockExecFile.mockImplementation(((_command, args, _options, callback) => {
    const gitArgs = args as string[]
    const stdout = gitArgs.includes("--name-only")
      ? `${files.join("\n")}\n`
      : gitArgs[0] === "show"
        ? content
        : "@@ -0,0 +1 @@\n+document.modelContext.registerTool({})\n"
    const done = callback as unknown as (
      error: Error | null,
      stdout: string,
      stderr: string
    ) => void
    done(null, stdout, "")
    return {} as ReturnType<typeof execFile>
  }) as typeof execFile)
}

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    version: "webmcp-inventory/1" as const,
    detectorVersion: "webmcp-assurance/1",
    definitions: [],
    checksum: "a".repeat(64),
    incompleteDefinitions: 0,
    limitsReached: [],
    unsupportedFiles: [],
    truncatedFiles: [],
    notes: [],
    ...overrides,
  }
}

describe("runWebMcpDiffChecks coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDiscover.mockResolvedValue({ inventory: inventory(), context: {} })
  })

  it("reports files above the per-file bound", async () => {
    mockGit(["large.ts"], "x".repeat(1024 * 1024 + 1))

    const findings = await runWebMcpDiffChecks("base", "head")

    expect(findings[0]).toMatchObject({
      ruleId: "WEBMCP-COVERAGE-INCOMPLETE",
      coverageIncomplete: true,
      message: expect.stringContaining("max_file_bytes"),
    })
  })

  it("reports the cumulative byte bound without dropping the coverage state", async () => {
    mockGit(
      Array.from({ length: 16 }, (_, index) => `tool-${index}.ts`),
      "x".repeat(700 * 1024)
    )

    const findings = await runWebMcpDiffChecks("base", "head")

    expect(findings[0]?.message).toContain("max_total_bytes")
  })

  it("reports definition and incomplete-parser limits from discovery", async () => {
    mockGit(["tool.ts"], "document.modelContext.registerTool(buildTool())")
    mockDiscover.mockResolvedValue({
      inventory: inventory({
        incompleteDefinitions: 1,
        limitsReached: ["max_definitions"],
      }),
      context: {},
    })

    const findings = await runWebMcpDiffChecks("base", "head")

    expect(findings[0]?.message).toContain("incomplete_definitions")
    expect(findings[0]?.message).toContain("max_definitions")
  })

  it("reports parser failure as incomplete coverage", async () => {
    mockGit(["tool.ts"], "document.modelContext.registerTool({})")
    mockDiscover.mockRejectedValue(new Error("parse failed"))

    const findings = await runWebMcpDiffChecks("base", "head")

    expect(findings[0]?.message).toContain("parser_error")
  })

  it("fails closed for changed code or component source formats discovery does not support", async () => {
    mockGit(["App.vue", "Tool.svelte", "widget.mdx", "script.py"], "const tool = {}")

    const findings = await runWebMcpDiffChecks("base", "head")

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "WEBMCP-COVERAGE-INCOMPLETE",
        coverageIncomplete: true,
        message: expect.stringContaining("unsupported_language"),
      }),
    ])
    expect(mockDiscover).not.toHaveBeenCalled()
  })

  it("does not flag changed documentation or binary assets as unsupported source", async () => {
    mockGit(["README.md", "assets/logo.png", "docs/guide.pdf"], "ignored")

    await expect(runWebMcpDiffChecks("base", "head")).resolves.toEqual([])
    expect(mockDiscover).not.toHaveBeenCalled()
  })

  it("keeps supported changed files in the existing discovery flow", async () => {
    mockGit(["tool.ts"], "document.modelContext.registerTool({})")

    await expect(runWebMcpDiffChecks("base", "head")).resolves.toEqual([])
    expect(mockDiscover).toHaveBeenCalledTimes(1)
  })
})
