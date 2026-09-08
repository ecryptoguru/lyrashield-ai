import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createLyraShieldServer } from "./create-server"
import { resolveMcpCredentials } from "./credentials"
import { logger } from "@lyrashield/logger"

// Stdio is reserved for MCP JSON-RPC; route every structured log to stderr.
process.env.LYRASHIELD_LOG_DESTINATION = "stderr"

/**
 * LyraShield MCP server entrypoint (stdio). All wiring — SDK server, security
 * engine, prompt-injection guard, and credential authorization — lives
 * in {@link createLyraShieldServer}. This file resolves credentials (env or
 * ~/.lyrashield/credentials.json) and then starts the transport.
 *
 * Auth: the tool handlers call the LyraShield REST API using the API key from
 * LYRASHIELD_API_KEY, falling back to the CLI credentials file. LYRASHIELD_API_URL
 * overrides the base URL (defaults to https://app.lyrashieldai.com).
 *
 * Credentials authorize execution at the REST boundary. Role, scope, target,
 * revocation, and budget checks run on every request; no second TTY prompt is needed.
 */

const allowMutations = true

async function main() {
  const { apiKey, apiUrl } = await resolveMcpCredentials()
  const { server, engine } = createLyraShieldServer({
    allowMutations,
    toolContext: {
      apiBaseUrl: apiUrl,
      apiKey,
      getCredentials: resolveMcpCredentials,
    },
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info("LyraShield MCP server connected (stdio, SDK)", {
    tools: engine.listTools().map((t) => t.name),
    allowMutations,
  })
}

main().catch((err) => {
  logger.error("LyraShield MCP server failed to start", {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
