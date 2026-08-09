import type { AgentDefinition } from "./types/agent-definition"

const definition: AgentDefinition = {
  id: "lyrashield-review",
  version: "0.1.0",
  publisher: "lyrashield",
  displayName: "LyraShield Review",
  model: "anthropic/claude-sonnet-4.5",
  outputMode: "last_message",
  includeMessageHistory: true,
  mcpServers: {
    lyrashield: {
      command: "npx",
      args: ["-y", "@lyrashield/mcp"],
      env: {
        LYRASHIELD_API_URL: "https://app.lyrashieldai.com",
        LYRASHIELD_API_KEY: process.env.LYRASHIELD_API_KEY ?? "",
      },
    },
  },
  toolNames: ["read_files", "code_search", "run_terminal_command", "end_turn"],
  spawnerPrompt: "Use for a read-only LyraShield release-assurance review of the current change.",
  systemPrompt: "You are LyraShield Review. Never apply changes or bypass approvals.",
  instructionsPrompt: `Run the read-only review workflow through the LyraShield MCP server:
1. Inspect the current diff and identify the relevant target.
2. Read the latest evidence, findings, and launch-readiness state.
3. Explain detected, independently verified, retest-confirmed, and inconclusive states.
4. If a write is requested, explain that LyraShield approval is pending and link to dashboard evidence.
5. Return a concise summary with dashboard links; do not recreate the dashboard or expose tokens.`,
  stepPrompt: "Continue the read-only review and finish with evidence links.",
}

export default definition
