import type { Policy, RuleFormat } from "../types.js"

export function renderMarkdownBody(policy: Policy, headingLevel = 2): string {
  const lines: string[] = []
  for (const section of policy.sections) {
    const prefix = "#".repeat(headingLevel)
    lines.push(`${prefix} ${section.title}`, "")
    if (section.id === "honesty") {
      lines.push(section.instructions.join(" "))
    } else if (section.id === "scope-limits") {
      lines.push(section.instructions.map((i) => `- ${i}`).join("\n"))
    } else {
      lines.push(section.instructions.map((i, index) => `${index + 1}. ${i}`).join("\n"))
    }
  }
  return lines.join("\n")
}

export function defaultRulePath(format: RuleFormat): string {
  switch (format) {
    case "claude-code":
      return "CLAUDE.md"
    case "agents-md":
      return "AGENTS.md"
    case "cursor":
      return ".cursor/rules/lyrashield.mdc"
    case "copilot":
      return ".github/copilot-instructions.md"
    case "windsurf":
      return ".windsurf/rules/lyrashield.md"
    case "cline":
      return ".clinerules"
    case "openclaw":
      return "skills/lyrashield/skill.md"
  }
}
