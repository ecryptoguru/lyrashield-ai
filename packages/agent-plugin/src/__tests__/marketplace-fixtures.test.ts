import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createAllTools } from "@lyrashield/mcp"

const repoRoot = path.resolve(new URL("../../../../", import.meta.url).pathname)
const marketplaceRoot = path.join(repoRoot, "docs", "marketplace")

describe("marketplace fixtures", () => {
  it("validates MCP Registry preparation against the raw vendored schema offline", async () => {
    const schemaPath = path.join(marketplaceRoot, "mcp-registry", "schema", "server.schema.json")
    const schema = await readFile(schemaPath)
    const schemaHash = createHash("sha256").update(schema).digest("hex")
    const provenance = await readFile(
      path.join(marketplaceRoot, "mcp-registry", "schema", "PROVENANCE.md"),
      "utf8"
    )
    expect(provenance).toContain(schemaHash)

    const validation = spawnSync(
      process.execPath,
      [path.join(marketplaceRoot, "mcp-registry", "validate.mjs")],
      { cwd: repoRoot, encoding: "utf8" }
    )
    expect(validation.status, validation.stderr || validation.stdout).toBe(0)
    expect(validation.stdout).toContain("PREPARATION ONLY")
  })

  it("keeps Codebuff's curated MCP allowlist read-only", async () => {
    const { default: agent } =
      await import("../../../../docs/marketplace/codebuff/lyrashield-review")
    const names = agent.toolNames ?? []
    const mcpNames = names.filter((name) => name.startsWith("lyrashield/"))
    const curatedTools = [
      "get_findings",
      "get_launch_readiness",
      "list_workspaces",
      "list_targets",
      "get_scan_status",
      "get_scan_quality",
      "check_diff",
      "explain_finding",
      "generate_fix_plan",
      "create_pr_security_recap",
    ]
    expect(mcpNames).toEqual(curatedTools.map((name) => "lyrashield/lyrashield_" + name))

    const tools = createAllTools({ apiBaseUrl: "", apiKey: "" })
    for (const name of curatedTools) {
      expect(tools.find((tool) => tool.name === "lyrashield_" + name)?.mutating).toBe(false)
    }
    expect(mcpNames).not.toContain("lyrashield/lyrashield_get_scan_eligibility")
    expect(mcpNames).not.toContain("lyrashield/lyrashield_list_scan_attachments")
    expect(names).not.toContain("run_terminal_command")
  })
  it("keeps Gemini and Cline contracts machine-readable", async () => {
    const gemini = JSON.parse(
      await readFile(
        path.join(marketplaceRoot, "gemini-extension", "gemini-extension.json"),
        "utf8"
      )
    ) as Record<string, unknown>
    const cline = JSON.parse(
      await readFile(path.join(marketplaceRoot, "cline", "submission.json"), "utf8")
    ) as Record<string, unknown>
    expect(gemini).toMatchObject({ name: "lyrashield-ai", version: "0.1.31" })
    expect(gemini.mcpServers).toBeTruthy()
    expect(cline).toMatchObject({
      license: "Apache-2.0",
      defaultScope: "lyrashield.read",
      writeScope: "lyrashield.write",
    })
  })

  it("ships reviewer-safe workflows and accurate community wording", async () => {
    const workflows = JSON.parse(
      await readFile(path.join(marketplaceRoot, "reviewer-pack", "workflows.json"), "utf8")
    ) as {
      review: {
        test_cases: {
          positive: Array<{ description: string; prompt: string; expected_behavior: string }>
          negative: Array<{ description: string; prompt: string }>
        }
      }
      supplementalSafetyChecks: Array<{
        id: string
        kind: string
        status: string
        expectedReceipt: string
      }>
    }
    const pluginManifest = JSON.parse(
      await readFile(
        path.join(repoRoot, "packages", "agent-plugin", "plugin", "plugin.json"),
        "utf8"
      )
    ) as {
      extensions: {
        "com.openai": {
          review: { test_cases: typeof workflows.review.test_cases }
        }
      }
    }
    const openclaw = await readFile(path.join(marketplaceRoot, "openclaw", "SKILL.md"), "utf8")
    const reviewerGuide = await readFile(
      path.join(marketplaceRoot, "reviewer-pack", "README.md"),
      "utf8"
    )
    const testCases = workflows.review.test_cases
    expect(testCases).toEqual(pluginManifest.extensions["com.openai"].review.test_cases)
    expect(testCases.positive).toHaveLength(5)
    expect(testCases.negative).toHaveLength(3)
    expect(
      testCases.positive.every((testCase) => testCase.prompt && testCase.expected_behavior)
    ).toBe(true)
    expect(testCases.negative.every((testCase) => testCase.prompt && testCase.description)).toBe(
      true
    )
    expect(workflows.supplementalSafetyChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "conflicting-idempotency-retry",
          kind: "negative",
          status: "NOT_RUN",
          expectedReceipt: expect.stringContaining("rejects the conflicting retry"),
        }),
        expect.objectContaining({
          id: "revoked-connection",
          kind: "negative",
          status: "NOT_RUN",
          expectedReceipt: expect.stringContaining("fail closed"),
        }),
      ])
    )
    expect(reviewerGuide).toContain("five positive and three negative cases")
    expect(reviewerGuide).toContain("They are separate from OpenAI's required three negative cases")
    expect(reviewerGuide).toMatch(/marked\s+`NOT_RUN`/)
    expect(openclaw).toContain("not an official OpenClaw channel")
  })
})
