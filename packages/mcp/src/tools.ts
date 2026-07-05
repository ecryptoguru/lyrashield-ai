export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export const scanTargetTool: McpTool = {
  name: "lyrashield_scan_target",
  description: "Trigger a security scan on a registered target. Requires workspaceId and targetId.",
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
    const workspaceId = args.workspaceId as string
    const targetId = args.targetId as string
    const goal = (args.goal as string) ?? "full_audit"
    const mode = (args.mode as string) ?? "SAFE"

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: "scan_triggered",
          workspaceId,
          targetId,
          goal,
          mode,
          message: "Scan queued. Poll /api/scans/{id} for status.",
        }),
      }],
    }
  },
}

export const getFindingsTool: McpTool = {
  name: "lyrashield_get_findings",
  description: "Retrieve security findings for a workspace, optionally filtered by severity or target.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string", description: "Workspace ID" },
      targetId: { type: "string", description: "Optional target ID filter" },
      severity: { type: "string", description: "Optional severity filter: CRITICAL, HIGH, MEDIUM, LOW, INFO" },
      limit: { type: "number", description: "Max results (default 50, max 100)" },
    },
    required: ["workspaceId"],
  },
  handler: async (args) => {
    const workspaceId = args.workspaceId as string
    const severity = args.severity as string | undefined
    const targetId = args.targetId as string | undefined

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: "get_findings",
          workspaceId,
          ...(targetId ? { targetId } : {}),
          ...(severity ? { severity } : {}),
          message: "Query /api/findings?workspaceId=... to retrieve findings.",
        }),
      }],
    }
  },
}

export const getLaunchReadinessTool: McpTool = {
  name: "lyrashield_get_launch_readiness",
  description: "Get a launch-readiness verdict (GO / GO_WITH_CONDITIONS / NO_GO) based on open findings.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string", description: "Workspace ID" },
      targetId: { type: "string", description: "Optional target ID filter" },
    },
    required: ["workspaceId"],
  },
  handler: async (args) => {
    const workspaceId = args.workspaceId as string
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: "get_launch_readiness",
          workspaceId,
          message: "Query /api/launch-readiness?workspaceId=... to get the verdict.",
        }),
      }],
    }
  },
}

export const createReportTool: McpTool = {
  name: "lyrashield_create_report",
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
    const workspaceId = args.workspaceId as string
    const title = args.title as string

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          action: "create_report",
          workspaceId,
          title,
          message: "POST /api/reports to create the report.",
        }),
      }],
    }
  },
}

export const ALL_TOOLS: McpTool[] = [
  scanTargetTool,
  getFindingsTool,
  getLaunchReadinessTool,
  createReportTool,
]
