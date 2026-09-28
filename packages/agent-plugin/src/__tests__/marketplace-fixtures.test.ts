import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createAllTools } from "@lyrashield/mcp"

const repoRoot = path.resolve(new URL("../../../../", import.meta.url).pathname)
const marketplaceRoot = path.join(repoRoot, "docs", "marketplace")

describe("marketplace fixtures", () => {
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
    expect(gemini).toMatchObject({ name: "lyrashield-ai", version: "0.1.30" })
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
