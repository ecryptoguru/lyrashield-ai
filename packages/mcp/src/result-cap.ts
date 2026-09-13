import type { McpToolResult } from "./tools"

/** Documented result ceiling: 256 KiB serialized per tool call. */
export const MCP_RESULT_MAX_BYTES = 256 * 1024
export const MCP_TRUNCATION_MARKER = "[… truncated — result exceeded the 256 KiB tool-result cap]"

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/**
 * Bounds the wire size of a tool result: each text content entry and the
 * serialized structuredContent are capped at 256 KiB. Truncated payloads carry
 * an explicit marker/flag so clients never mistake a partial result for a
 * complete one.
 */
export function capToolResult(result: McpToolResult): McpToolResult {
  let content = result.content
  if (content) {
    let changed = false
    const next = content.map((entry) => {
      if (entry.type === "text" && byteLength(entry.text) > MCP_RESULT_MAX_BYTES) {
        changed = true
        const budget = MCP_RESULT_MAX_BYTES - byteLength(MCP_TRUNCATION_MARKER) - 1
        let text = entry.text
        while (byteLength(text) > budget) text = text.slice(0, Math.floor(text.length * 0.9))
        return { ...entry, text: `${text}\n${MCP_TRUNCATION_MARKER}` }
      }
      return entry
    })
    if (changed) content = next
  }

  let structuredContent = result.structuredContent
  if (structuredContent !== undefined) {
    const serialized = JSON.stringify(structuredContent)
    if (byteLength(serialized) > MCP_RESULT_MAX_BYTES) {
      structuredContent = {
        truncated: true,
        truncatedAt: MCP_RESULT_MAX_BYTES,
        marker: MCP_TRUNCATION_MARKER,
        preview: serialized.slice(0, MCP_RESULT_MAX_BYTES),
      }
    }
  }

  if (content === result.content && structuredContent === result.structuredContent) return result
  return { ...result, content, structuredContent }
}
