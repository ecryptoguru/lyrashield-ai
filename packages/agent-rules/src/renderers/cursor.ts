import type { Policy, RenderRuleOptions } from "../types.js"
import { renderMarkdownBody } from "./shared.js"

export function renderCursor(policy: Policy, opts: RenderRuleOptions): string {
  const body = renderMarkdownBody(policy, 2)
  const file = opts.file ?? ".cursor/rules/lyrashield.mdc"
  const isMdc = file.endsWith(".mdc")

  if (isMdc) {
    return `---
description: LyraShield AI security policy for Cursor
globs: "*.{md,ts,tsx,js,jsx,py,go,rs,yml,yaml,json,jsonc,toml,prisma,sql}"
alwaysApply: false
---

# LyraShield security checks

${body}
`
  }

  return `# LyraShield security checks

${body}
`
}
