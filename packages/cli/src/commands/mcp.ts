import minimist from "minimist"
import { getEffectiveCredentials, requireApiKey } from "../credentials.js"
import type { Output } from "../output.js"

const MCP_ENDPOINT = "/api/mcp"
const PROTOCOL_VERSION = "2025-06-18"

export async function handleMcp(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["help"],
    alias: { h: "help" },
    default: { help: false },
  })

  if (parsed.help || parsed._.length < 2) {
    output.notice(usage())
    return 0
  }

  const [subcommand, toolName] = parsed._ as string[]
  if (subcommand !== "call") {
    output.error(`Unknown mcp subcommand: ${subcommand}`)
    output.notice(usage())
    return 2
  }

  const rawInput = (parsed.input as string | undefined) ?? "{}"
  let toolArgs: Record<string, unknown>
  try {
    toolArgs = JSON.parse(rawInput) as Record<string, unknown>
  } catch {
    output.error("--input must be valid JSON")
    return 2
  }

  const creds = await getEffectiveCredentials()
  const apiKey = requireApiKey(creds)
  const baseUrl = (creds.apiUrl ?? "https://app.lyrashieldai.com").replace(/\/+$/, "")

  const initReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "lyrashield-cli", version: "0.1.0" },
    },
  }

  const callReq = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${apiKey}`,
  }

  // Initialize first (stateless transport still requires protocol negotiation).
  const initRes = await fetch(`${baseUrl}${MCP_ENDPOINT}`, {
    method: "POST",
    headers,
    body: JSON.stringify(initReq),
  })
  if (!initRes.ok) {
    output.error(`MCP initialization failed: ${initRes.status} ${initRes.statusText}`)
    return 1
  }

  const callRes = await fetch(`${baseUrl}${MCP_ENDPOINT}`, {
    method: "POST",
    headers,
    body: JSON.stringify(callReq),
  })
  if (!callRes.ok) {
    output.error(`MCP call failed: ${callRes.status} ${callRes.statusText}`)
    return 1
  }

  const text = await callRes.text()
  const json = parseSseJson(text, callRes.headers.get("content-type")) as
    Record<string, unknown> | undefined
  const result = (json?.result ?? json) as Record<string, unknown> | undefined

  if (result && typeof result === "object") {
    const content = (result.content as Array<{ text: string }> | undefined) ?? []
    const isError = result.isError === true
    const payload = content[0]?.text ? tryParseJson(content[0].text) : result

    if (isError && payload && (payload as Record<string, unknown>).status === "PENDING") {
      output.warn("This action is awaiting human approval.")
      output.result(payload)
      return 0
    }

    if (payload && (payload as Record<string, unknown>).status === "PENDING") {
      output.notice("This action is awaiting human approval.")
      output.result(payload)
      return 0
    }

    if (isError) {
      output.error(JSON.stringify(payload ?? result, null, 2))
      return 1
    }

    output.result(payload ?? result)
    return 0
  }

  output.result(json)
  return 0
}

function usage(): string {
  return `lyrashield mcp call <toolName> --input '{...}'

Call a remote MCP tool and display the result, including pending-approval responses.

Options:
  --input '{"key":"val"}'   Tool arguments as JSON`
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseSseJson(text: string, contentType: string | null): unknown {
  if (contentType?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"))
    const payload = line ? line.slice(5).trim() : "{}"
    return tryParseJson(payload)
  }
  return tryParseJson(text)
}
