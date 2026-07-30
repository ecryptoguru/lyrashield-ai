import type { Policy, RenderRuleOptions } from "../types.js"
import { renderMarkdownBody } from "./shared.js"

export function renderClaudeCode(policy: Policy, _opts: RenderRuleOptions): string {
  const body = renderMarkdownBody(policy, 2)
  return `# LyraShield security checks

LyraShield is available as an MCP server and a Claude Code plugin/skill. Use it to verify security posture before creating a pull request and after applying a security fix.

You can surface these checks as:
- This \`CLAUDE.md\` section.
- A skill in \`.claude/skills/lyrashield/SKILL.md\` (if your project uses skills).
- A PreToolUse hook that runs \`lyrashield check-diff --staged\` before the \`git commit\` or \`pr create\` tool is used.
- A slash command \`/lyra-diff\` that runs \`lyrashield check-diff --staged\`.

${body}
`
}
