import type { Policy, RenderRuleOptions } from "../types.js"
import { renderMarkdownBody } from "./shared.js"

export function renderCline(policy: Policy, _opts: RenderRuleOptions): string {
  const body = renderMarkdownBody(policy, 2)
  return `# LyraShield security checks

${body}
`
}
