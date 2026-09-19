import type { McpToolResult } from "./tools"

/** Maximum UTF-8 size of the complete serialized tool result. */
export const MCP_RESULT_MAX_BYTES = 256 * 1024
export const MCP_TRUNCATION_MARKER = "[… truncated — result exceeded the 256 KiB tool-result cap]"

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

export function capToolResult(result: McpToolResult): McpToolResult {
  const originalBytes = size(result)
  if (originalBytes <= MCP_RESULT_MAX_BYTES) return result

  const source = result.content.find((entry) => entry.type === "text")?.text ??
    JSON.stringify(result.structuredContent ?? result)
  const structured = result.structuredContent as Record<string, unknown> | undefined
  const continuation: Record<string, unknown> = {}
  for (const key of ["id", "scanId", "operationId", "workspaceId", "nextCursor", "cursor"]) {
    const value = structured?.[key]
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") < 1024) {
      continuation[key] = value
    }
  }
  for (const [field, key] of [["scan", "scanId"], ["operation", "operationId"]] as const) {
    const nested = structured?.[field]
    if (nested && typeof nested === "object" && "id" in nested &&
      typeof nested.id === "string" && Buffer.byteLength(nested.id, "utf8") < 1024) {
      continuation[key] = nested.id
    }
  }
  const metadata = {
    truncated: true,
    complete: false,
    originalBytes,
    marker: MCP_TRUNCATION_MARKER,
    ...continuation,
  }
  const make = (length: number): McpToolResult => ({
    content: [{ type: "text", text: `${source.slice(0, length)}\n${MCP_TRUNCATION_MARKER}` }],
    structuredContent: metadata,
    ...(result.isError ? { isError: true } : {}),
  })
  let low = 0
  let high = source.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (size(make(mid)) <= MCP_RESULT_MAX_BYTES) low = mid
    else high = mid - 1
  }
  return make(low)
}
