import { createInterface } from "readline"
import { McpServer } from "./server"
import { logger } from "@lyrashield/logger"

interface JsonRpcRequest {
  jsonrpc: string
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: string
  id?: string | number
  result?: unknown
  error?: { code: number; message: string }
}

const server = new McpServer()

const rl = createInterface({ input: process.stdin, output: process.stdout })

function sendResponse(response: JsonRpcResponse) {
  process.stdout.write(JSON.stringify(response) + "\n")
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { method, params, id } = request

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            ...server.getServerInfo(),
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
          },
        }

      case "notifications/initialized":
      case "initialized":
        // Notification — no response (handled by caller for no-id case, but handle here too for safety)
        return {
          jsonrpc: "2.0",
          id,
          result: {},
        }

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: server.listTools(),
          },
        }

      case "tools/call": {
        const toolName = params?.name as string
        const args = (params?.arguments as Record<string, unknown>) ?? {}
        const result = await server.callTool(toolName, args)
        return {
          jsonrpc: "2.0",
          id,
          result,
        }
      }

      case "shutdown":
        return {
          jsonrpc: "2.0",
          id,
          result: null,
        }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }
    }
  } catch (err) {
    logger.error("MCP stdio handler error", {
      method,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Internal error" },
    }
  }
}

rl.on("line", async (line: string) => {
  if (!line.trim()) return

  let request: JsonRpcRequest
  try {
    request = JSON.parse(line)
  } catch {
    sendResponse({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
    })
    return
  }

  // JSON-RPC notifications (no id) must not receive a response
  if (request.id === undefined) {
    // Handle known notifications silently
    if (request.method === "notifications/initialized" || request.method === "initialized") {
      return
    }
    // Unknown notifications — ignore per spec
    return
  }

  const response = await handleRequest(request)
  sendResponse(response)
})

rl.on("close", () => {
  logger.info("MCP stdio transport closed")
  process.exit(0)
})

logger.info("MCP stdio transport started", {
  serverName: server.getServerInfo().name,
  tools: server.listTools().map((t) => t.name),
})
