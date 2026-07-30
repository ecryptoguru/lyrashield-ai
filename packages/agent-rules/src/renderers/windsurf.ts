import type { Policy, RenderRuleOptions } from "../types.js"
import { renderMarkdownBody } from "./shared.js"

export function renderWindsurf(policy: Policy, _opts: RenderRuleOptions): string {
  const body = renderMarkdownBody(policy, 2)
  return `# LyraShield security workflow for Windsurf

## Workflow

1. Before creating a PR: run \`lyrashield check-diff --staged\` on the changed files.
2. Review any findings and wait for resolution or explicit acceptance before proceeding.
3. After applying a security fix: run \`lyrashield verify-fix <finding-id>\`.
4. Include the verification receipt in the PR description.
5. Only scan authorized targets listed in the LyraShield workspace.

${body}
`
}
