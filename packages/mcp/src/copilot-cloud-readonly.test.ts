import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { MCP_TOOL_ANNOTATIONS } from "./tools"

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))
const guidePath = path.join(repositoryRoot, "docs/marketplace/github-copilot-cloud-agent/README.md")
const skillsRoot = path.join(repositoryRoot, "packages/agent-plugin/plugin/skills")

describe("Copilot Cloud Agent read-only integration contract", () => {
  it("allowlists only tools used by the documented read-only skills", () => {
    const guide = readFileSync(guidePath, "utf8")
    const configJson = guide.match(/```json\s*([\s\S]*?)\s*```/)?.[1]
    expect(configJson).toBeDefined()

    const config = JSON.parse(configJson!) as {
      mcpServers: { lyrashield: { tools: string[] } }
    }
    const allowedTools = config.mcpServers.lyrashield.tools
    const skillNames = ["get-started", "review-changes", "launch-readiness"]
    const readOnlySkillTools = new Set<string>()
    const allSkillTools = new Set<string>()

    for (const skillName of skillNames) {
      expect(guide).toContain(`\`${skillName}\``)
      const skillPath = path.join(skillsRoot, skillName, "SKILL.md")
      const skill = readFileSync(skillPath, "utf8")
      for (const toolName of skill.match(/\blyrashield_[a-z0-9_]+\b/g) ?? []) {
        allSkillTools.add(toolName)
        const annotation = MCP_TOOL_ANNOTATIONS[toolName]
        expect(annotation, `${skillName} references registered tool ${toolName}`).toBeDefined()
        if (annotation.readOnlyHint) readOnlySkillTools.add(toolName)
      }
    }

    expect(allowedTools).toEqual([...readOnlySkillTools].sort())
    for (const toolName of allowedTools) {
      expect(MCP_TOOL_ANNOTATIONS[toolName]?.readOnlyHint, toolName).toBe(true)
    }
    for (const toolName of allSkillTools) {
      expect(MCP_TOOL_ANNOTATIONS[toolName], toolName).toBeDefined()
    }
    expect(allowedTools).not.toContain("lyrashield_run_pr_scan")
    expect(guide).toContain("OAuth-capable client")
    expect(guide).toContain("scan-project")
    expect(guide).toContain("fix-and-retest")
  })
})
