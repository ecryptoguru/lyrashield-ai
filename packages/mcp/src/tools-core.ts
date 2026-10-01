import { OperationStatusSchema } from "@lyrashield/sdk"
import {
  apiCall,
  IDEMPOTENCY_KEY_PROPERTY,
  makeErrorResult,
  makeToolResult,
  resolveTargetId,
  workflowInputFields,
  WORKFLOW_INPUT_PROPERTIES,
  type McpTool,
  type ToolHandlerContext,
} from "./tool-shared"

export function createScanTargetTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_scan_target",
    mutating: true,
    description:
      "Trigger a security scan on a registered target. Provide targetId or provide repo (owner/repo) and/or auto=true to detect and auto-create a repo target. Workflow REVIEW_CHANGES on a repository target requires baseRef and records an immutable diff-scope plan.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Target ID to scan (or use repo/auto instead)" },
        repo: {
          type: "string",
          description:
            "Repository to scan, e.g. ecryptoguru/lyrashield-ai. If the target does not exist, it is created.",
        },
        auto: {
          type: "boolean",
          description:
            "Detect the current git repo from the working directory and use or create a target.",
        },
        goal: {
          type: "string",
          description:
            "Scan goal: CHECK_PR, TEST_APP, LAUNCH_REVIEW, WEEKLY_MONITOR, FULL_PENTEST or COMPLIANCE_REVIEW",
        },
        mode: {
          type: "string",
          description:
            "Scan depth: QUICK, STANDARD, DEEP or CUSTOM. SAFE remains a compatibility alias for QUICK. Depth is always explicit — it is never inferred from the target shape.",
        },
        ...WORKFLOW_INPUT_PROPERTIES,
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const resolved = await resolveTargetId(context, args)
        const data = await apiCall(context, "POST", "/api/scans", {
          workspaceId: args.workspaceId,
          idempotencyKey: args.idempotencyKey,
          targetId: resolved.targetId,
          goal: (args.goal as string) ?? "TEST_APP",
          mode: (args.mode as string) ?? "STANDARD",
          ...workflowInputFields(args),
        })
        const result: Record<string, unknown> = { action: "scan_triggered", scan: data }
        if (resolved.repository) result.repository = resolved.repository
        return makeToolResult(result)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createCancelScanTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_cancel_scan",
    mutating: true,
    description:
      "Request cancellation of a queued or running scan. Stops further engine work and billing shortly after the request lands; already-recorded findings are preserved. If the scan is already terminal or its finalization has started, the API returns a conflict — inspect the result with lyrashield_get_scan_status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
        workspaceId: { type: "string", description: "Workspace ID" },
        scanId: { type: "string", description: "Scan ID to cancel" },
      },
      required: ["workspaceId", "scanId"],
    },
    handler: async (args) => {
      try {
        const data = await apiCall(
          context,
          "POST",
          `/api/scans/${encodeURIComponent(args.scanId as string)}`,
          {
            workspaceId: args.workspaceId,
            idempotencyKey: args.idempotencyKey,
          }
        )
        return makeToolResult({ action: "scan_cancel_requested", scan: data })
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
      "Retrieve a page of security findings. Follow nextCursor with cursor until it is absent.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Optional target ID filter" },
        scanId: { type: "string", description: "Optional scan ID filter" },
        cursor: { type: "string", description: "Cursor returned as nextCursor by the prior page" },
        status: { type: "string", description: "Optional finding status filter" },
        verified: { type: "boolean", description: "Optional verification status filter" },
        severity: {
          type: "string",
          description: "Optional severity filter: CRITICAL, HIGH, MEDIUM, LOW, INFO",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 50)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const limit = args.limit ?? 50
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return makeErrorResult("limit must be an integer from 1 to 100")
        }
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        if (args.targetId) params.set("targetId", args.targetId as string)
        if (args.scanId) params.set("scanId", args.scanId as string)
        if (args.cursor) params.set("cursor", args.cursor as string)
        if (args.status) params.set("status", args.status as string)
        if (typeof args.verified === "boolean") params.set("verified", String(args.verified))
        if (args.severity) params.set("severity", args.severity as string)
        params.set("limit", String(limit))

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
      "Get the versioned release-gate result for one target. READY is enforceable only when a matching commit or artifact digest is supplied.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Target ID" },
        commit: { type: "string", description: "Optional 40-character release commit SHA" },
        artifactDigest: { type: "string", description: "Optional sha256 artifact digest" },
      },
      required: ["workspaceId", "targetId"],
    },
    handler: async (args) => {
      try {
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        if (typeof args.commit === "string") params.set("commit", args.commit)
        if (typeof args.artifactDigest === "string")
          params.set("artifactDigest", args.artifactDigest)

        const data = await apiCall(
          context,
          "GET",
          `/api/gate/${encodeURIComponent(args.targetId as string)}?${params.toString()}`
        )
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
    description:
      "Generate a shareable security report from scan findings. Pass targetId to use that target's latest completed scan or pass scanId for an exact scan.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
        workspaceId: { type: "string", description: "Workspace ID" },
        scanId: { type: "string", description: "Optional scan ID to report on" },
        targetId: {
          type: "string",
          description: "Optional target ID; uses its latest completed scan when scanId is omitted",
        },
        title: { type: "string", description: "Report title" },
        type: { type: "string", description: "Report type: developer, executive, compliance" },
      },
      required: ["workspaceId", "title"],
    },
    handler: async (args) => {
      try {
        const data = await apiCall(context, "POST", "/api/reports", {
          workspaceId: args.workspaceId,
          idempotencyKey: args.idempotencyKey,
          ...(args.scanId ? { scanId: args.scanId } : {}),
          ...(args.targetId ? { targetId: args.targetId } : {}),
          title: args.title,
          type: args.type ?? "developer",
        })
        const snapshotReused =
          data !== null &&
          typeof data === "object" &&
          "snapshotReused" in data &&
          data.snapshotReused === true
        return makeToolResult({
          action: snapshotReused ? "report_reused" : "report_created",
          report: data,
        })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Discovery tools — let an IDE user resolve the IDs the other tools require
// without leaving the editor. All read-only.
// ---------------------------------------------------------------------------

export function createListWorkspacesTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_list_workspaces",
    mutating: false,
    description:
      "List the workspaces this API key can access. Use this first to find the workspaceId the other tools need.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        return makeToolResult(await apiCall(context, "GET", "/api/workspaces"))
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createListTargetsTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_list_targets",
    mutating: false,
    description:
      "List a page of registered targets (repos / apps / APIs). Follow nextCursor with cursor to reach later pages.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        projectId: { type: "string", description: "Optional project ID filter" },
        cursor: { type: "string", description: "Cursor returned as nextCursor by the prior page" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 50)" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const limit = args.limit ?? 50
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return makeErrorResult("limit must be an integer from 1 to 100")
        }
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        if (args.projectId) params.set("projectId", args.projectId as string)
        if (args.cursor) params.set("cursor", args.cursor as string)
        params.set("limit", String(limit))
        return makeToolResult(await apiCall(context, "GET", `/api/targets?${params.toString()}`))
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createGetScanStatusTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_get_scan_status",
    mutating: false,
    description:
      "Get the current status, timing and event trail of a scan by its scanId. Poll this after starting a scan. Supply operationId instead of scanId to inspect durable retry status and recovery.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        operationId: {
          type: "string",
          description: "Durable operation ID; mutually exclusive with scanId",
        },
        scanId: { type: "string", description: "Scan ID" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        if (Boolean(args.operationId) === Boolean(args.scanId))
          return makeErrorResult("Supply exactly one of scanId or operationId.")
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        const data = await apiCall(
          context,
          "GET",
          `/api/${args.operationId ? "agent-operations" : "scans"}/${encodeURIComponent((args.operationId ?? args.scanId) as string)}?${params.toString()}`
        )
        return makeToolResult(args.operationId ? OperationStatusSchema.parse(data) : data)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createGetScanEligibilityTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_get_scan_eligibility",
    mutating: false,
    description:
      "Advisory read-only preflight for a security scan on a registered target: whether POST /api/scans would currently admit the requested review — same permission, plan, domain-proof and entitlement gates, evaluated with no trial, billing, scan or audit mutation. allowed:false is a successful read carrying the structured denial code/message/blockers, not a tool error. POST /api/scans re-checks authoritatively at creation; a pass here never guarantees admission. Inputs mirror lyrashield_scan_target (goal, mode, workflow fields); the workflow and attachment semantics match POST.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        targetId: {
          type: "string",
          description: "An existing target id (lyrashield_list_targets).",
        },
        goal: {
          type: "string",
          enum: [
            "CHECK_PR",
            "TEST_APP",
            "LAUNCH_REVIEW",
            "WEEKLY_MONITOR",
            "FULL_PENTEST",
            "COMPLIANCE_REVIEW",
          ],
          description: "Review intent. Default TEST_APP.",
        },
        mode: {
          type: "string",
          enum: ["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"],
          description:
            "Review depth. QUICK is an alias for SAFE on URL targets; CUSTOM is an alias for DEEP on repository targets. Default STANDARD.",
        },
        ...WORKFLOW_INPUT_PROPERTIES,
      },
      required: ["workspaceId", "targetId"],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        if (typeof args.workspaceId !== "string" || !args.workspaceId) {
          throw new Error("workspaceId is required")
        }
        if (typeof args.targetId !== "string" || !args.targetId) {
          throw new Error("targetId is required")
        }
        const fields = workflowInputFields(args)
        const workflow = fields.workflow as string | undefined
        const baseRef = fields.baseRef as string | undefined
        const headRef = fields.headRef as string | undefined
        const attachmentIds = fields.attachmentIds as string[] | undefined
        const authorizationRef = fields.authorizationRef as string | undefined
        const params = new URLSearchParams()
        params.set("workspaceId", args.workspaceId)
        params.set("targetId", args.targetId)
        params.set("goal", typeof args.goal === "string" && args.goal ? args.goal : "TEST_APP")
        params.set("mode", typeof args.mode === "string" && args.mode ? args.mode : "STANDARD")
        if (workflow) params.set("workflow", workflow)
        if (baseRef) params.set("baseRef", baseRef)
        if (headRef) params.set("headRef", headRef)
        for (const id of attachmentIds ?? []) params.append("attachmentIds", id)
        if (authorizationRef) params.set("authorizationRef", authorizationRef)
        const data = await apiCall(context, "GET", `/api/scans/eligibility?${params}`)
        return makeToolResult(data)
      } catch (err) {
        return makeErrorResult(
          err instanceof Error ? err.message : "Failed to evaluate scan eligibility"
        )
      }
    },
  }
}

export function createGetScanQualityTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_get_scan_quality",
    mutating: false,
    description:
      "Get a scan's measured evidence-quality surface: stored-evidence facts (finding verification tiers, coverage receipts, manifest checksum), labeled heuristics and the per-surface parity table. Read-only; nothing here is a model claim or accuracy guarantee.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        scanId: { type: "string", description: "Scan ID" },
      },
      required: ["workspaceId", "scanId"],
    },
    handler: async (args) => {
      try {
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        const data = await apiCall(
          context,
          "GET",
          `/api/scans/${encodeURIComponent(args.scanId as string)}/quality?${params.toString()}`
        )
        return makeToolResult(data)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Workflow tools — the developer loop (pre-PR check → scan → explain → fix →
// verify → recap). Honest scoping: check_diff and the recap are advisory
// read-only helpers; a full recorded scan always runs server-side.
// ---------------------------------------------------------------------------

// The advisory pattern table lives in @lyrashield/security/diff-advisory so
// this tool and the CLI share one detector inventory. This is a fast heuristic
// pre-filter, NOT a scanner — real detection is the full server-side scan.
