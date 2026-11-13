import { isJsonObject } from "@lyrashield/types"
import { publicScanResult } from "./scan-provenance"

function publicScanPayload(payload: Record<string, unknown>) {
  const scan = payload.scan
  if (isJsonObject(scan) && ("executionPlan" in scan || "executionPlanHash" in scan)) {
    return { ...payload, scan: publicScanResult(scan) }
  }
  return payload
}

/** Redact historical hosted MCP receipts without modifying their durable history. */
export function publicScanToolResult<
  T extends {
    content: { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
  },
>(result: T): T {
  return {
    ...result,
    ...(result.structuredContent
      ? { structuredContent: publicScanPayload(result.structuredContent) }
      : {}),
    content: result.content.map((item) => {
      if (item.type !== "text" || typeof item.text !== "string") return item
      try {
        const payload: unknown = JSON.parse(item.text)
        return isJsonObject(payload)
          ? { ...item, text: JSON.stringify(publicScanPayload(payload)) }
          : item
      } catch {
        return item
      }
    }),
  }
}
