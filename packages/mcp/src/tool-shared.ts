import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { LyraShieldClient, parseRepoIdentifier, type ParsedRepo } from "@lyrashield/sdk"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

const execFileAsync = promisify(execFile)

export const McpToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
})
export type McpToolResult = z.infer<typeof McpToolResultSchema>

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

export function getClient(context: ToolHandlerContext): LyraShieldClient {
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

export async function apiCall(
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
      /\/scans\/[^/?]+$/.test(sdkPath) ||
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

export async function resolveTargetId(
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
export const WORKFLOW_INPUT_PROPERTIES = {
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
export function workflowInputFields(args: Record<string, unknown>): Record<string, unknown> {
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

export function makeToolResult(data: unknown): McpToolResult {
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

export function makeErrorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
    structuredContent: { error: message },
  }
}
