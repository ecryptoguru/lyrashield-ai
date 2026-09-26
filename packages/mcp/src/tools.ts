import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  LyraShieldClient,
  deleteScanAttachment,
  listScanAttachments,
  getScanEligibility,
  requestFixPr,
  uploadScanAttachment,
  OperationStatusSchema,
  parseRepoIdentifier,
  type ParsedRepo,
} from "@lyrashield/sdk"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { analyzeDiffAdvisory } from "@lyrashield/security/diff-advisory"

const execFileAsync = promisify(execFile)

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

export const MCP_TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  lyrashield_scan_target: {
    title: "Run a LyraShield scan",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  lyrashield_cancel_scan: {
    title: "Cancel a LyraShield scan",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  lyrashield_list_scan_attachments: {
    title: "List scan attachments",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_scan_eligibility: {
    title: "Check scan eligibility",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_upload_scan_attachment: {
    title: "Upload scan attachment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  lyrashield_delete_scan_attachment: {
    title: "Delete scan attachment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  lyrashield_request_fix_pr: {
    title: "Request a fix pull request",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  lyrashield_get_findings: {
    title: "Get findings",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_launch_readiness: {
    title: "Get launch readiness",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_create_report: {
    title: "Create security report",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  lyrashield_list_workspaces: {
    title: "List workspaces",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_list_targets: {
    title: "List targets",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_scan_status: {
    title: "Get scan status",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_get_scan_quality: {
    title: "Get scan evidence quality",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_check_diff: {
    title: "Check a diff",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_run_pr_scan: {
    title: "Run a pull-request scan",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  lyrashield_explain_finding: {
    title: "Explain a finding",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_generate_fix_plan: {
    title: "Generate a fix plan",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  lyrashield_record_fix_proposal: {
    title: "Record a fix proposal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  lyrashield_verify_fix: {
    title: "Verify a fix",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  lyrashield_create_pr_security_recap: {
    title: "Create pull-request security recap",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
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
  annotations?: ToolAnnotations
  outputSchema?: {
    type: "object"
    properties?: Record<string, object>
    required?: string[]
  }
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export interface ToolHandlerContext {
  apiBaseUrl: string
  apiKey: string
  fetchFn?: typeof fetch
  /** Remote MCP servers cannot inspect the coding client's working directory. */
  allowAutoDetect?: boolean
  /** Dynamic credentials resolver for long-lived servers */
  getCredentials?: () => Promise<{ apiKey: string; apiUrl?: string }>
}

function getClient(context: ToolHandlerContext): LyraShieldClient {
  return new LyraShieldClient({
    apiKey: context.apiKey,
    apiUrl: context.apiBaseUrl,
    fetchFn: context.fetchFn,
    getAccessToken: context.getCredentials
      ? async () => {
          const creds = await context.getCredentials!()
          return creds.apiKey
        }
      : undefined,
  })
}

async function apiCall(
  context: ToolHandlerContext,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const client = getClient(context)
  const sdkPath = path.replace(/^\/api\/v1/, "").replace(/^\/api/, "") || "/"
  const recorded =
    method === "POST" &&
    (sdkPath === "/scans" ||
      sdkPath === "/reports" ||
      /\/findings\/[^/]+\/(retests|fix-proposals)$/.test(sdkPath))
  if (!recorded || !body) return client.request(method, sdkPath, body ? { body } : undefined)
  const { idempotencyKey, ...input } = body
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 128)
  )
    throw new Error("Invalid idempotency key")
  // Separate the HTTP sub-operation from the hosted MCP execution claim.
  const key =
    typeof idempotencyKey === "string"
      ? `mcp:${createHash("sha256").update(idempotencyKey).digest("hex")}`
      : randomUUID()
  return client.request(method, sdkPath, { body: input, headers: { "Idempotency-Key": key } })
}

async function detectGitRepo(cwd = process.cwd()): Promise<ParsedRepo | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "-v"], { cwd })
    for (const line of stdout.split("\n")) {
      const match = line.match(/^origin\s+(\S+)\s+\(fetch\)/)
      if (match) {
        const remote = match[1]
        if (remote) {
          const repo = parseRepoIdentifier(remote)
          if (repo) return repo
        }
      }
    }
  } catch {
    // not a git repo or git not available
  }
  return undefined
}

async function findOrCreateRepoTarget(
  context: ToolHandlerContext,
  workspaceId: string,
  repo: ParsedRepo
): Promise<string> {
  let cursor: string | undefined
  const seen = new Set<string>()
  let pages = 0
  do {
    if (++pages > 20) throw new Error("Target lookup incomplete after 20 pages; pass targetId")
    const params = new URLSearchParams({ workspaceId })
    if (cursor) params.set("cursor", cursor)
    const list = (await apiCall(context, "GET", `/api/targets?${params.toString()}`)) as {
      items?: Array<{
        id: string
        repoFullName?: string | null
      }>
      nextCursor?: string | null
    }

    const existing = list.items?.find((t) => t.repoFullName === repo.repoFullName)
    if (existing) return existing.id
    cursor = list.nextCursor ?? undefined
    if (cursor && seen.has(cursor))
      throw new Error("Target lookup returned a repeated cursor; pass targetId")
    if (cursor) seen.add(cursor)
  } while (cursor)

  const created = (await apiCall(context, "POST", "/api/targets", {
    workspaceId,
    name: repo.repoName,
    type: "REPO",
    repoProvider: repo.repoProvider,
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
    repoFullName: repo.repoFullName,
  })) as { id: string }

  return created.id
}

async function resolveTargetId(
  context: ToolHandlerContext,
  args: Record<string, unknown>
): Promise<{ targetId: string; repository?: string }> {
  if (typeof args.targetId === "string") {
    return { targetId: args.targetId }
  }

  if (!args.workspaceId || typeof args.workspaceId !== "string") {
    throw new Error("workspaceId is required")
  }

  let repo: ParsedRepo | undefined
  if (typeof args.repo === "string") {
    repo = parseRepoIdentifier(args.repo)
    if (!repo) throw new Error(`Invalid repo: ${args.repo}`)
  } else if (args.auto === true) {
    if (context.allowAutoDetect === false) {
      throw new Error(
        "auto=true is available only from the local stdio MCP server. Pass repo or targetId to the hosted MCP endpoint."
      )
    }
    repo = await detectGitRepo()
    if (!repo) throw new Error("No git origin remote found in the current directory.")
  } else {
    throw new Error("Either targetId, repo or auto=true is required.")
  }

  const targetId = await findOrCreateRepoTarget(context, args.workspaceId, repo)
  return { targetId, repository: repo.repoFullName }
}

/**
 * Shared scan-workflow input contract for the recorded-scan tools
 * (`lyrashield_scan_target`, `lyrashield_run_pr_scan`). The fields mirror
 * POST /api/scans verbatim: the server resolves refs to immutable git object
 * IDs and owns the execution plan; the MCP layer only forwards workflow
 * intent — it never builds plan fields, limits or capabilities itself.
 */
const WORKFLOW_INPUT_PROPERTIES = {
  workflow: {
    type: "string",
    description:
      "Recorded workflow: REVIEW_TARGET (default snapshot/live review) or REVIEW_CHANGES (immutable diff review on a repository target, requires baseRef). AUTHENTICATED_ASSESSMENT is a gated staging beta — it requires authorizationRef and is denied server-side unless the deployment enables it for this workspace/target.",
  },
  baseRef: {
    type: "string",
    description:
      "Review Changes comparison base — a branch name or full commit SHA the server resolves to an immutable git object ID.",
  },
  headRef: {
    type: "string",
    description:
      "Review Changes comparison head — a branch name or full commit SHA. Defaults to the target's recorded branch.",
  },
  attachmentIds: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional IDs of previously staged workspace input-evidence attachments recorded into the execution plan. Never host paths.",
  },
  authorizationRef: {
    type: "string",
    description:
      "AUTHENTICATED_ASSESSMENT only: the recorded scoped authorization reference. Never a credential.",
  },
} as const

const VALID_WORKFLOWS = new Set(["REVIEW_TARGET", "REVIEW_CHANGES", "AUTHENTICATED_ASSESSMENT"])

/**
 * Validate and project the caller's workflow inputs onto the scan-create
 * body. Throws on inconsistent input so the error is local and clear rather
 * than a remote 400. AUTHENTICATED_ASSESSMENT is passed through with its
 * authorizationRef — the server applies the gated beta admission (flag +
 * allowlist + recorded scoped authorization) so the denial is consistent
 * across every client.
 */
function workflowInputFields(args: Record<string, unknown>): Record<string, unknown> {
  const workflow = typeof args.workflow === "string" ? args.workflow : undefined
  const baseRef = typeof args.baseRef === "string" ? args.baseRef : undefined
  const headRef = typeof args.headRef === "string" ? args.headRef : undefined
  const attachmentIds = args.attachmentIds
  const authorizationRef =
    typeof args.authorizationRef === "string" ? args.authorizationRef : undefined

  if (workflow !== undefined && !VALID_WORKFLOWS.has(workflow)) {
    throw new Error(`Invalid workflow. Choose: ${[...VALID_WORKFLOWS].join(", ")}`)
  }
  if (headRef && !baseRef) {
    throw new Error("headRef requires baseRef so the change set can be compared.")
  }
  if ((baseRef || headRef) && workflow !== "REVIEW_CHANGES") {
    throw new Error("baseRef/headRef are only valid with workflow REVIEW_CHANGES.")
  }
  if (workflow === "REVIEW_CHANGES" && !baseRef) {
    throw new Error("REVIEW_CHANGES requires a baseRef to compare against.")
  }
  if (authorizationRef && workflow !== "AUTHENTICATED_ASSESSMENT") {
    throw new Error("authorizationRef is only valid with workflow AUTHENTICATED_ASSESSMENT.")
  }
  if (attachmentIds !== undefined) {
    if (
      !Array.isArray(attachmentIds) ||
      attachmentIds.length > 20 ||
      attachmentIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)
    ) {
      throw new Error("attachmentIds must be an array of at most 20 non-empty id strings.")
    }
  }

  return {
    ...(workflow ? { workflow } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(headRef ? { headRef } : {}),
    ...(attachmentIds !== undefined ? { attachmentIds } : {}),
    ...(authorizationRef ? { authorizationRef } : {}),
  }
}

function makeToolResult(data: unknown): McpToolResult {
  const structuredContent =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { data }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent,
  }
}

function makeErrorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
    structuredContent: { error: message },
  }
}

export function createScanTargetTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_scan_target",
    mutating: true,
    description:
      "Trigger a security scan on a registered target. Provide targetId or provide repo (owner/repo) and/or auto=true to detect and auto-create a repo target. Workflow REVIEW_CHANGES on a repository target requires baseRef and records an immutable diff-scope plan.",
    inputSchema: {
      type: "object",
      properties: {
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
      "Explicitly cancel an owned scan. Stopping a status poll does not cancel work. Hosted calls require a separate scan.cancel grant and stable idempotency key; a terminal or finalizing scan returns a conflict.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        scanId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["workspaceId", "scanId"],
    },
    handler: async (args) => {
      try {
        const key = args.idempotencyKey
        const scan = await getClient(context).request(
          "POST",
          `/scans/${encodeURIComponent(args.scanId as string)}`,
          {
            body: { workspaceId: args.workspaceId },
            ...(typeof key === "string"
              ? {
                  headers: {
                    "Idempotency-Key": `mcp:${createHash("sha256").update(key).digest("hex")}`,
                  },
                }
              : {}),
          }
        )
        return makeToolResult({ action: "scan_cancelled", scan })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

const MCP_ATTACHMENT_MAX_BYTES = 64 * 1024

export function createListScanAttachmentsTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_list_scan_attachments",
    mutating: false,
    description:
      "List workspace supporting scan attachment metadata. Content and storage paths are never returned. A connected client needs an explicit attachment.read grant.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const items = await listScanAttachments(getClient(context), args.workspaceId as string)
        return makeToolResult({ items })
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
      "Advisory read-only scan preflight for a registered target and explicit goal/mode. It never reserves work or minutes; scan submission rechecks policy.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        targetId: { type: "string", minLength: 1, maxLength: 128 },
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
        },
        mode: { type: "string", enum: ["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"] },
        ...WORKFLOW_INPUT_PROPERTIES,
      },
      required: ["workspaceId", "targetId", "goal", "mode"],
    },
    handler: async (args) => {
      try {
        const result = await getScanEligibility(getClient(context), {
          workspaceId: args.workspaceId as string,
          targetId: args.targetId as string,
          goal: args.goal as string,
          mode: args.mode as string,
          ...workflowInputFields(args),
        })
        return makeToolResult(result)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createUploadScanAttachmentTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_upload_scan_attachment",
    mutating: true,
    description:
      "Upload an explicitly supplied UTF-8 text/Markdown/JSON/YAML supporting file (up to 64 KiB through MCP). No local paths, URLs, archives, or binary files. A connected client needs an explicit workspace-wide attachment.upload grant.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        filename: { type: "string", minLength: 1, maxLength: 128 },
        mediaType: { type: "string", minLength: 1, maxLength: 128 },
        content: { type: "string", minLength: 1, maxLength: MCP_ATTACHMENT_MAX_BYTES },
      },
      required: ["workspaceId", "filename", "mediaType", "content"],
    },
    handler: async (args) => {
      try {
        if (typeof args.content !== "string") {
          return makeErrorResult("Attachment content must be UTF-8 text.")
        }
        const content = new TextEncoder().encode(args.content as string)
        if (content.byteLength > MCP_ATTACHMENT_MAX_BYTES) {
          return makeErrorResult("Attachment exceeds the 64 KiB MCP upload limit; use the CLI.")
        }
        const key = args.idempotencyKey
        const attachment = await uploadScanAttachment(getClient(context), {
          workspaceId: args.workspaceId as string,
          filename: args.filename as string,
          mediaType: args.mediaType as string,
          content,
          ...(typeof key === "string"
            ? { idempotencyKey: `mcp:${createHash("sha256").update(key).digest("hex")}` }
            : {}),
        })
        return makeToolResult({ attachment })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createDeleteScanAttachmentTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_delete_scan_attachment",
    mutating: true,
    description:
      "Delete an owned workspace scan attachment by ID. A connected client needs an explicit workspace-wide attachment.delete grant.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        attachmentId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["workspaceId", "attachmentId"],
    },
    handler: async (args) => {
      try {
        const key = args.idempotencyKey
        const result = await deleteScanAttachment(getClient(context), args.attachmentId as string, {
          workspaceId: args.workspaceId as string,
          ...(typeof key === "string"
            ? { idempotencyKey: `mcp:${createHash("sha256").update(key).digest("hex")}` }
            : {}),
        })
        return makeToolResult(result)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createRequestFixPrTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_request_fix_pr",
    mutating: true,
    description:
      "Request a pull request from a stored, server-generated fix proposal. Only a proposal ID is accepted; the server binds target, patch and base revision. A pending approval is not an opened PR.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", minLength: 1, maxLength: 128 },
        proposalId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["workspaceId", "proposalId"],
    },
    handler: async (args) => {
      try {
        if (
          Object.keys(args).some(
            (key) => !["workspaceId", "proposalId", "idempotencyKey", "approvalId"].includes(key)
          )
        ) {
          return makeErrorResult("Only workspaceId and proposalId may define a fix PR request.")
        }
        const key = args.idempotencyKey
        const result = await requestFixPr(getClient(context), args.proposalId as string, {
          workspaceId: args.workspaceId as string,
          ...(typeof key === "string"
            ? { idempotencyKey: `mcp:${createHash("sha256").update(key).digest("hex")}` }
            : {}),
        })
        return makeToolResult(result)
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
      properties: {
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

/**
 * Creates the offline `lyrashield_check_diff` tool. The `context` parameter is
 * unused (no API call, no state change) but is kept for consistency with the
 * other tool factory functions.
 */
export function createCheckDiffTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_check_diff",
    mutating: false,
    description:
      "Fast ADVISORY heuristic scan of a code diff for obviously risky patterns (hardcoded secrets, eval, unsafe HTML, SQL concatenation). This is a lightweight pre-PR pre-filter only — it is NOT a substitute for a full recorded scan. Run lyrashield_run_pr_scan for a bounded repository scan with findings, coverage receipts, evidence states and explicit limitations; results are not automatically independently verified or exploit-validated.",
    inputSchema: {
      type: "object",
      properties: {
        diff: {
          type: "string",
          description:
            "The unified diff or code snippet to check (added lines are most relevant). Max 1 MiB.",
        },
        files: {
          type: "array",
          description:
            "Optional final source snapshots for WebMCP analysis; paths label supplied content only.",
          maxItems: 500,
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["diff"],
    },
    handler: async (args) => {
      void context
      const diff = typeof args.diff === "string" ? args.diff : ""
      if (!diff.trim()) {
        return makeToolResult({
          advisory: [],
          checked: 0,
          coverage: { state: "INCOMPLETE", scope: "supplied-inputs", reasons: ["empty_diff"] },
          note: "Empty diff — nothing to check.",
        })
      }
      const files = args.files as Array<{ path: string; content: string }> | undefined
      try {
        const result = await analyzeDiffAdvisory({ diff, files })
        const advisory = result.findings.map((finding) => ({
          id:
            finding.ruleId === "eval-exec" && /\beval\s*\(/.test(finding.sourceLine ?? "")
              ? "eval"
              : finding.ruleId,
          label:
            finding.ruleId === "hardcoded-secret"
              ? "Possible hardcoded secret or API key"
              : finding.ruleId === "eval-exec" && /\beval\s*\(/.test(finding.sourceLine ?? "")
                ? "Use of eval()"
                : finding.message,
          line: finding.sourceLine ?? "",
          ...(finding.file ? { file: finding.file } : {}),
          ...(finding.line === undefined ? {} : { lineNumber: finding.line }),
          severity: finding.severity,
        }))
        return makeToolResult({
          advisory,
          checked: result.checked,
          coverage: result.coverage,
          note:
            result.coverage.state === "INCOMPLETE"
              ? "Advisory coverage is incomplete. Run lyrashield_run_pr_scan for a recorded scan with coverage receipts."
              : "Advisory findings are heuristic and may include false positives. Run lyrashield_run_pr_scan for a full recorded scan.",
        })
      } catch (error) {
        return {
          ...makeToolResult({
            advisory: [],
            checked: 0,
            coverage: { state: "INCOMPLETE", scope: "supplied-inputs", reasons: ["invalid_input"] },
            note: error instanceof Error ? error.message : "Invalid diff advisory input",
          }),
          isError: true,
        }
      }
    },
  }
}

export function createRunPrScanTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_run_pr_scan",
    mutating: true,
    description:
      "Start a PR-focused security scan (goal CHECK_PR) on a registered target. Provide targetId or provide repo (owner/repo) and/or auto=true to detect and auto-create a repo target. Pass baseRef/headRef for a recorded Review Changes diff run — distinct from the advisory lyrashield_check_diff pre-filter, which records nothing.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: {
          type: "string",
          description: "Target ID (the repo/app to scan or use repo/auto instead)",
        },
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
        mode: {
          type: "string",
          description:
            "Scan depth: QUICK (default), STANDARD, DEEP or CUSTOM. SAFE remains a compatibility alias for QUICK. Depth is always explicit — it is never inferred from the target shape.",
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
          goal: "CHECK_PR",
          mode: (args.mode as string) ?? "QUICK",
          ...workflowInputFields(args),
        })
        const result: Record<string, unknown> = { action: "pr_scan_started", scan: data }
        if (resolved.repository) result.repository = resolved.repository
        return makeToolResult(result)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createExplainFindingTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_explain_finding",
    mutating: false,
    description:
      "Get the full detail and plain-language explanation (what it is, why it matters, how to fix) for a single finding by its findingId.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        findingId: { type: "string", description: "Finding ID" },
      },
      required: ["workspaceId", "findingId"],
    },
    handler: async (args) => {
      try {
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        const data = await apiCall(
          context,
          "GET",
          `/api/findings/${encodeURIComponent(args.findingId as string)}?${params.toString()}`
        )
        return makeToolResult(data)
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createGenerateFixPlanTool(context: ToolHandlerContext): McpTool {
  return {
    // Read-only: assembles a remediation plan from the finding's recorded
    // detail. Recording it as a proposal is a separate, gated tool
    // (lyrashield_record_fix_proposal) so the common "just show me the plan"
    // call needs no approval.
    name: "lyrashield_generate_fix_plan",
    mutating: false,
    description:
      "Assemble a remediation plan for a finding from its recorded detail, recommended fix and plain-language explanation. Read-only — records nothing. Use lyrashield_record_fix_proposal to persist a proposal on the finding.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        findingId: { type: "string", description: "Finding ID" },
      },
      required: ["workspaceId", "findingId"],
    },
    handler: async (args) => {
      try {
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        const finding = (await apiCall(
          context,
          "GET",
          `/api/findings/${encodeURIComponent(args.findingId as string)}?${params.toString()}`
        )) as Record<string, unknown>
        return makeToolResult({
          action: "fix_plan",
          findingId: args.findingId,
          title: finding.title,
          severity: finding.severity,
          recommendedFix: finding.recommendedFix ?? null,
          plainLanguage: finding.plainLanguage ?? null,
          note: "Plan only — nothing recorded. Use lyrashield_record_fix_proposal to persist it.",
        })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createRecordFixProposalTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_record_fix_proposal",
    mutating: true,
    description:
      "Record a fix proposal on a finding (the remediation summary you intend to apply). Requires write scope; current connection permissions apply.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        findingId: { type: "string", description: "Finding ID" },
        summary: {
          type: "string",
          description: "The fix summary to record (minimum 10 characters).",
        },
      },
      required: ["workspaceId", "findingId", "summary"],
    },
    handler: async (args) => {
      try {
        const summary = typeof args.summary === "string" ? args.summary : ""
        if (summary.trim().length < 10) {
          return makeErrorResult("`summary` must be at least 10 characters.")
        }
        const proposal = await apiCall(
          context,
          "POST",
          `/api/findings/${encodeURIComponent(args.findingId as string)}/fix-proposals`,
          {
            workspaceId: args.workspaceId,
            idempotencyKey: args.idempotencyKey,
            summary,
            generatedByModel: "mcp-client",
          }
        )
        return makeToolResult({ action: "fix_proposal_recorded", proposal })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createVerifyFixTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_verify_fix",
    mutating: true,
    description:
      "Queue a retest of a finding to verify a fix. The retest re-runs against the finding's original target and mode. Returns the retest/scan reference to poll.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        findingId: { type: "string", description: "Finding ID to retest" },
      },
      required: ["workspaceId", "findingId"],
    },
    handler: async (args) => {
      try {
        const data = await apiCall(
          context,
          "POST",
          `/api/findings/${encodeURIComponent(args.findingId as string)}/retests`,
          { workspaceId: args.workspaceId, idempotencyKey: args.idempotencyKey }
        )
        return makeToolResult({ action: "retest_queued", retest: data })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createPrSecurityRecapTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_create_pr_security_recap",
    mutating: false,
    description:
      "Assemble a PR-ready security recap for one target: the effective release-gate result and unresolved findings by severity. Read-only — paste the result into a PR comment.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Target ID to scope the recap" },
        commit: { type: "string", description: "Optional 40-character release commit SHA" },
        artifactDigest: { type: "string", description: "Optional sha256 artifact digest" },
      },
      required: ["workspaceId", "targetId"],
    },
    handler: async (args) => {
      try {
        const wsParam = new URLSearchParams({ workspaceId: args.workspaceId as string })
        const targetId = args.targetId as string
        const gateParams = new URLSearchParams(wsParam)
        if (typeof args.commit === "string") gateParams.set("commit", args.commit)
        if (typeof args.artifactDigest === "string")
          gateParams.set("artifactDigest", args.artifactDigest)

        const readiness = await apiCall(
          context,
          "GET",
          `/api/gate/${encodeURIComponent(targetId)}?${gateParams.toString()}`
        )

        const bySeverity: Record<string, number> = {}
        let findingCount = 0
        let cursor: string | undefined
        const seenCursors = new Set<string>()
        const deadline = Date.now() + 20_000
        const timeout = new AbortController()
        const timer = setTimeout(() => timeout.abort(), 20_000)
        const baseFetch = context.fetchFn ?? globalThis.fetch
        const boundedContext: ToolHandlerContext = {
          ...context,
          fetchFn: (input, init) =>
            baseFetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, timeout.signal])
                : timeout.signal,
            }),
        }
        let complete = true
        let pages = 0
        try {
          do {
            if (pages >= 20 || Date.now() >= deadline) {
              complete = false
              break
            }
            pages++
            const findingParams = new URLSearchParams(wsParam)
            findingParams.set("limit", "100")
            findingParams.set("targetId", targetId)
            if (cursor) findingParams.set("cursor", cursor)
            let page: {
              items?: Array<Record<string, unknown>>
              nextCursor?: string | null
            }
            try {
              page = (await apiCall(
                boundedContext,
                "GET",
                `/api/findings?${findingParams.toString()}`
              )) as typeof page
            } catch (error) {
              if (!timeout.signal.aborted) throw error
              complete = false
              break
            }
            if (Array.isArray(page.items)) {
              for (const finding of page.items) {
                if (
                  ![
                    "OPEN",
                    "FIX_READY",
                    "PR_OPENED",
                    "TICKET_CREATED",
                    "FIXED_PENDING_RETEST",
                  ].includes(String(finding.status))
                )
                  continue
                const severity = String(finding.severity ?? "UNKNOWN")
                bySeverity[severity] = (bySeverity[severity] ?? 0) + 1
                findingCount++
              }
            }
            cursor = page.nextCursor ?? undefined
            if (cursor && seenCursors.has(cursor)) {
              complete = false
              break
            }
            if (cursor) seenCursors.add(cursor)
          } while (cursor)
        } finally {
          clearTimeout(timer)
        }

        const readinessObj = (readiness ?? {}) as Record<string, unknown>
        const verdict = String(readinessObj.state ?? "INSUFFICIENT_EVIDENCE")
        const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
        const sevLines = order
          .filter((s) => bySeverity[s])
          .map((s) => `- **${s}**: ${bySeverity[s]}`)
          .join("\n")

        const markdown = [
          `## 🛡️ LyraShield security recap`,
          ``,
          `**Launch readiness:** ${verdict}`,
          ``,
          !complete
            ? `**Open findings:** incomplete after ${pages} pages; resume with cursor ${cursor ?? "(none)"}.`
            : sevLines
              ? `**Open findings by severity:**\n${sevLines}`
              : `**Open findings:** none`,
          ``,
          `_This is a target-scoped release-gate snapshot. Findings retain their recorded evidence states; scan detection alone is not independent verification or exploit validation._`,
        ].join("\n")

        return makeToolResult({
          markdown,
          verdict,
          bySeverity,
          findingCount,
          complete,
          nextCursor: complete ? null : (cursor ?? null),
        })
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

export function createAllTools(context: ToolHandlerContext): McpTool[] {
  return [
    // Discovery
    createListWorkspacesTool(context),
    createListTargetsTool(context),
    createGetScanStatusTool(context),
    createGetScanEligibilityTool(context),
    createListScanAttachmentsTool(context),
    createGetScanQualityTool(context),
    // Core
    createScanTargetTool(context),
    createCancelScanTool(context),
    createUploadScanAttachmentTool(context),
    createDeleteScanAttachmentTool(context),
    createRequestFixPrTool(context),
    createGetFindingsTool(context),
    createGetLaunchReadinessTool(context),
    createCreateReportTool(context),
    // Workflow loop
    createCheckDiffTool(context),
    createRunPrScanTool(context),
    createExplainFindingTool(context),
    createGenerateFixPlanTool(context),
    createRecordFixProposalTool(context),
    createVerifyFixTool(context),
    createPrSecurityRecapTool(context),
  ]
}
