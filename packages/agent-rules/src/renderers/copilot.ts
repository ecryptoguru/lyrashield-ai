import type { Policy, RenderRuleOptions } from "../types.js"
import { renderMarkdownBody } from "./shared.js"

export function renderCopilot(policy: Policy, _opts: RenderRuleOptions): string {
  const body = renderMarkdownBody(policy, 2)
  return `# LyraShield security instructions for GitHub Copilot

${body}
`
}
