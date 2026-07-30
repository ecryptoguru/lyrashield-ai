export type RuleFormat =
  "claude-code" | "agents-md" | "cursor" | "copilot" | "windsurf" | "cline" | "openclaw"

export interface PolicySection {
  id: "pre-pr" | "post-fix" | "scope-limits" | "honesty"
  title: string
  instructions: string[]
}

export interface Policy {
  version: string
  title: string
  honestyClause: string
  sections: PolicySection[]
}

export interface RuleFile {
  format: RuleFormat
  file: string
  agentId: string
  agentDisplayName: string
  policyVersion: string
  inner: string
  content: string
  sha: string
}

export interface RenderRuleOptions {
  format: RuleFormat
  file?: string
  agentId: string
  agentDisplayName?: string
  policyVersion?: string
}

export interface RuleFormatInfo {
  format: RuleFormat
  label: string
  defaultFiles: string[]
}

export type RuleFileState = "valid" | "diverged" | "missing" | "untracked" | "unknown"

export interface RuleFileCheck {
  format: RuleFormat
  file: string
  state: RuleFileState
  version?: string
  sha?: string
}

export interface RuleOutcome {
  file: string
  format: RuleFormat
  action:
    | "added"
    | "updated"
    | "removed"
    | "skipped"
    | "would-add"
    | "would-update"
    | "would-remove"
    | "refused"
  reason?: string
  backupPath?: string
  sha?: string
}

export interface AddRulesOptions {
  projectRoot?: string
  dryRun?: boolean
  force?: boolean
  policyVersion?: string
}

export interface RemoveRulesOptions {
  projectRoot?: string
  dryRun?: boolean
}

export interface CheckRulesOptions {
  projectRoot?: string
}
