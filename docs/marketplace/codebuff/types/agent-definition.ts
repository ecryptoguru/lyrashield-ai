declare global {
  const process: { env: Record<string, string | undefined> }
}

export interface AgentDefinition {
  id: string
  version?: string
  publisher?: string
  displayName?: string
  model: string
  reasoningOptions?: unknown
  providerOptions?: unknown
  mcpServers?: Record<
    string,
    {
      command?: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
    }
  >
  toolNames?: string[]
  spawnableAgents?: string[]
  inputSchema?: unknown
  outputMode?: "last_message" | "all_messages" | "structured_output"
  outputSchema?: unknown
  spawnerPrompt?: string
  includeMessageHistory?: boolean
  inheritParentSystemPrompt?: boolean
  systemPrompt?: string
  instructionsPrompt?: string
  stepPrompt?: string
  handleSteps?: (context: unknown) => Generator<unknown, unknown, unknown>
}
