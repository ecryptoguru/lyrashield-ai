import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createLyraShieldServer } from "./create-server"
import { logger } from "@lyrashield/logger"

/**
 * LyraShield MCP server entrypoint (stdio). All wiring — SDK server, security
 * engine, prompt-injection guard, and the elicitation/TTY approval gate — lives
 * in {@link createLyraShieldServer}. This file just chooses the transport.
 *
 * Auth: the tool handlers call the LyraShield REST API with the workspace API
 * key from LYRASHIELD_API_KEY (Bearer). LYRASHIELD_API_URL overrides the base
 * URL (defaults to http://localhost:3000).
 *
 * Trusted-context opt-out: LYRASHIELD_MCP_ALLOW_MUTATIONS=true skips the
 * approval gate for non-interactive, pre-reviewed runs (e.g. CI).
 */

const allowMutations = process.env.LYRASHIELD_MCP_ALLOW_MUTATIONS === "true"

const { server, engine } = createLyraShieldServer({ allowMutations })

async function main() {
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
