/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createAllTools } from "@lyrashield/mcp"

const repoRoot = path.resolve(new URL("../../../../", import.meta.url).pathname)
const marketplaceRoot = path.join(repoRoot, "docs", "marketplace")

describe("marketplace fixtures", () => {
  it("restricts the Codebuff review agent to read-only MCP tools", async () => {
    const { default: agent } =
      await import("../../../../docs/marketplace/codebuff/lyrashield-review")
    const names = agent.toolNames ?? []
    const mcpNames = names.filter((name) => name.startsWith("lyrashield/"))
    const tools = createAllTools({ apiBaseUrl: "", apiKey: "" })
    expect(mcpNames).toHaveLength(tools.filter((tool) => !tool.mutating).length)
    for (const tool of tools) {
      expect(mcpNames.includes(`lyrashield/${tool.name}`)).toBe(!tool.mutating)
    }
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
    expect(gemini).toMatchObject({ name: "lyrashield-ai", version: "0.1.29" })
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
      positiveWorkflows: string[]
      safeFailures: string[]
    }
    const openclaw = await readFile(path.join(marketplaceRoot, "openclaw", "SKILL.md"), "utf8")
    const reviewerGuide = await readFile(
      path.join(marketplaceRoot, "reviewer-pack", "README.md"),
      "utf8"
    )
    expect(workflows.positiveWorkflows.join(" ")).toContain("idempotency key")
    expect(workflows.safeFailures.join(" ")).toContain("revoke")
    expect(reviewerGuide).toContain(`${workflows.positiveWorkflows.length} positive workflows`)
    expect(reviewerGuide).toContain(`${workflows.safeFailures.length} safe failures`)
    expect(openclaw).toContain("not an official OpenClaw channel")
  })
})
