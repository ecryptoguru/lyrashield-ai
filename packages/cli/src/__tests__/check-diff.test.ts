import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleCheckDiff } from "../commands/check-diff.js"
import { runDiffChecks } from "../diff-core.js"
import type { Output } from "../output.js"

vi.mock("../diff-core.js", () => ({
  resolveDiffRange: vi.fn(() => ({ base: "HEAD~1", head: "HEAD" })),
  runDiffChecks: vi.fn(),
  buildSarif: vi.fn(() => ({})),
}))

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

describe("handleCheckDiff", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reports incomplete WebMCP coverage without turning the advisory into a gate", async () => {
    mockRunDiffChecks.mockResolvedValue([
      {
        ruleId: "WEBMCP-COVERAGE-INCOMPLETE",
        level: "error",
        severity: "HIGH",
        message: "WebMCP diff coverage incomplete: max_definitions",
        coverageIncomplete: true,
      },
    ])
    const output = makeOutput()

    await expect(handleCheckDiff([], output)).resolves.toBe(0)
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("WEBMCP-COVERAGE-INCOMPLETE"))
  })
})
