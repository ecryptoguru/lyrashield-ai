import type { AgentDefinition } from "./types/agent-definition"

const apiKey = process.env.LYRASHIELD_API_KEY?.trim()

const definition: AgentDefinition = {
  id: "lyrashield-review",
  version: "0.1.29",
  publisher: "lyrashield",
  displayName: "LyraShield Review",
  model: "anthropic/claude-sonnet-4.5",
  outputMode: "last_message",
  includeMessageHistory: true,
  mcpServers: {
    lyrashield: {
      command: "npx",
      args: ["-y", "@lyrashield/mcp@0.2.9"],
      env: apiKey ? { LYRASHIELD_API_KEY: apiKey } : {},
    },
  },
  toolNames: [
    "read_files",
    "code_search",
    "end_turn",
    "lyrashield/lyrashield_get_findings",
    "lyrashield/lyrashield_get_launch_readiness",
    "lyrashield/lyrashield_list_workspaces",
    "lyrashield/lyrashield_list_targets",
    "lyrashield/lyrashield_get_scan_status",
    "lyrashield/lyrashield_get_scan_quality",
    "lyrashield/lyrashield_get_scan_eligibility",
    "lyrashield/lyrashield_check_diff",
    "lyrashield/lyrashield_explain_finding",
    "lyrashield/lyrashield_generate_fix_plan",
    "lyrashield/lyrashield_create_pr_security_recap",
    "lyrashield/lyrashield_list_scan_attachments",
  ],
  spawnerPrompt: "Use for a read-only LyraShield release-assurance review of the current change.",
  systemPrompt: "You are LyraShield Review. Never apply changes or bypass approvals.",
  instructionsPrompt: `Run the read-only review workflow through the LyraShield MCP server:
1. Inspect the supplied diff and identify the relevant target. Ask for the diff if it is not available to your read tools.
2. Read the latest evidence, findings and launch-readiness state.
3. Explain detected, independently verified, retest-confirmed and inconclusive states.
4. If a write is requested, explain that this agent exposes read-only tools. Local stdio authorization uses the credential's REST permissions; hosted OAuth delegation is a separate connection path.
5. Return a concise summary with dashboard links; do not recreate the dashboard or expose tokens.`,
  stepPrompt: "Continue the read-only review and finish with evidence links.",
}

export default definition
