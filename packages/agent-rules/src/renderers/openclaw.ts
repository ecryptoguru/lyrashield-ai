import type { Policy, RenderRuleOptions } from "../types.js"
import { renderMarkdownBody } from "./shared.js"

export function renderOpenClaw(policy: Policy, _opts: RenderRuleOptions): string {
  const body = renderMarkdownBody(policy, 2)
  return `---
name: lyra-shield-security
description: Run LyraShield security checks before and after changes
---

# LyraShield security workflow

${body}
`
}
