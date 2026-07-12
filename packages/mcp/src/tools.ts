export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export interface McpTool {
  name: string
  description: string
  /**
   * Whether this tool mutates state (triggers a scan, creates a report, opens a
   * PR, …). Mutating tools are gated behind a human-approval check in the server
   * before their handler runs — read-only tools are not. (S8)
   */
  mutating: boolean
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export interface ToolHandlerContext {
  apiBaseUrl: string
  apiKey?: string
  fetchFn?: typeof fetch
}

async function apiCall(
  context: ToolHandlerContext,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const fetchImpl = context.fetchFn ?? globalThis.fetch
  const url = `${context.apiBaseUrl}${path}`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (context.apiKey) {
    headers["Authorization"] = `Bearer ${context.apiKey}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    clearTimeout(timeout)

    if (!res.ok) {
      let errorMsg = `API returned ${res.status} ${res.statusText}`
      try {
        const errorJson = (await res.json()) as { error?: { message?: string } }
        if (errorJson.error?.message) errorMsg = errorJson.error.message
      } catch {
        // Response body is not JSON — use status text
      }
      throw new Error(errorMsg)
    }

    const json = (await res.json()) as {
      success: boolean
      data?: unknown
      error?: { message?: string }
    }
    if (!json.success) {
      throw new Error(json.error?.message ?? "API call failed")
    }
    return json.data
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

function makeToolResult(data: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  }
}

function makeErrorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  }
}

export function createScanTargetTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_scan_target",
    mutating: true,
    description:
      "Trigger a security scan on a registered target. Requires workspaceId and targetId.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Target ID to scan" },
        goal: { type: "string", description: "Scan goal (e.g., 'full_audit', 'quick_check')" },
        mode: { type: "string", description: "Scan mode: SAFE, DEEP, or AGGRESSIVE" },
      },
      required: ["workspaceId", "targetId"],
    },
    handler: async (args) => {
      try {
        const data = await apiCall(context, "POST", "/api/scans", {
          workspaceId: args.workspaceId,
          targetId: args.targetId,
          goal: (args.goal as string) ?? "full_audit",
          mode: (args.mode as string) ?? "SAFE",
        })
        return makeToolResult({ action: "scan_triggered", scan: data })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createGetFindingsTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_get_findings",
    mutating: false,
    description:
      "Retrieve security findings for a workspace, optionally filtered by severity or target.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Optional target ID filter" },
        severity: {
          type: "string",
          description: "Optional severity filter: CRITICAL, HIGH, MEDIUM, LOW, INFO",
        },
        limit: { type: "number", description: "Max results (default 50, max 100)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        if (args.targetId) params.set("targetId", args.targetId as string)
        if (args.severity) params.set("severity", args.severity as string)
        if (args.limit) params.set("limit", String(args.limit))

        const data = await apiCall(context, "GET", `/api/findings?${params.toString()}`)
        return makeToolResult(data)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createGetLaunchReadinessTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_get_launch_readiness",
    mutating: false,
    description:
      "Get a launch-readiness verdict (GO / GO_WITH_CONDITIONS / NO_GO) based on open findings.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Optional target ID filter" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        if (args.targetId) params.set("targetId", args.targetId as string)

        const data = await apiCall(context, "GET", `/api/launch-readiness?${params.toString()}`)
        return makeToolResult(data)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createCreateReportTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_create_report",
    mutating: true,
    description: "Generate a shareable security report from scan findings.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        scanId: { type: "string", description: "Optional scan ID to report on" },
        title: { type: "string", description: "Report title" },
        type: { type: "string", description: "Report type: developer, executive, compliance" },
      },
      required: ["workspaceId", "title"],
    },
    handler: async (args) => {
      try {
        const data = await apiCall(context, "POST", "/api/reports", {
          workspaceId: args.workspaceId,
          ...(args.scanId ? { scanId: args.scanId } : {}),
          title: args.title,
          type: args.type ?? "developer",
        })
        return makeToolResult({ action: "report_created", report: data })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createAllTools(context: ToolHandlerContext): McpTool[] {
  return [
    createScanTargetTool(context),
    createGetFindingsTool(context),
    createGetLaunchReadinessTool(context),
    createCreateReportTool(context),
  ]
}
