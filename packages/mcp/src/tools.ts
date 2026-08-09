import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { LyraShieldClient, parseRepoIdentifier, type ParsedRepo } from "@lyrashield/sdk"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"

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
  }
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export interface ToolHandlerContext {
  apiBaseUrl: string
  apiKey: string
  fetchFn?: typeof fetch
  /** Remote MCP servers cannot inspect the coding client's working directory. */
  allowAutoDetect?: boolean
}

function getClient(context: ToolHandlerContext): LyraShieldClient {
  return new LyraShieldClient({
    apiKey: context.apiKey,
    apiUrl: context.apiBaseUrl,
    fetchFn: context.fetchFn,
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
  return client.request(method, sdkPath, body ? { body } : undefined)
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
  do {
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
    throw new Error("Either targetId, repo, or auto=true is required.")
  }

  const targetId = await findOrCreateRepoTarget(context, args.workspaceId, repo)
  return { targetId, repository: repo.repoFullName }
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
      "Trigger a security scan on a registered target. Provide targetId, or provide repo (owner/repo) and/or auto=true to detect and auto-create a repo target.",
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
            "Scan goal: CHECK_PR, TEST_APP, LAUNCH_REVIEW, WEEKLY_MONITOR, FULL_PENTEST, or COMPLIANCE_REVIEW",
        },
        mode: {
          type: "string",
          description: "Scan mode: SAFE, QUICK, STANDARD, DEEP, or CUSTOM",
        },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const resolved = await resolveTargetId(context, args)
        const data = await apiCall(context, "POST", "/api/scans", {
          workspaceId: args.workspaceId,
          targetId: resolved.targetId,
          goal: (args.goal as string) ?? "TEST_APP",
          mode: (args.mode as string) ?? "STANDARD",
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
      "List the registered targets (repos / apps / APIs) in a workspace. Use this to find the targetId to scan.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        projectId: { type: "string", description: "Optional project ID filter" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const params = new URLSearchParams({ workspaceId: args.workspaceId as string })
        if (args.projectId) params.set("projectId", args.projectId as string)
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
      "Get the current status, timing, and event trail of a scan by its scanId. Poll this after starting a scan.",
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
          `/api/scans/${encodeURIComponent(args.scanId as string)}?${params.toString()}`
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
// read-only helpers; a real verified scan always runs server-side.
// ---------------------------------------------------------------------------

// High-signal, obviously-risky patterns for the local advisory diff check.
// This is a fast heuristic pre-filter, NOT a scanner — real detection is the
// server-side verified scan. Kept deliberately small and honest.
const DIFF_ADVISORY_PATTERNS: Array<{ id: string; label: string; re: RegExp }> = [
  {
    id: "hardcoded-secret",
    label: "Possible hardcoded secret or API key",
    re: /(?:api[_-]?key|secret|token|password|passwd|bearer)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  },
  { id: "private-key", label: "Embedded private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    id: "aws-key",
    label: "Possible AWS access key id",
    re: /AKIA[0-9A-Z]{16}/,
  },
  { id: "eval", label: "Use of eval()", re: /\beval\s*\(/ },
  {
    id: "dangerous-html",
    label: "React dangerouslySetInnerHTML",
    re: /dangerouslySetInnerHTML/,
  },
  {
    id: "sql-concat",
    label: "Possible SQL string concatenation",
    re: /(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*?["'`]\s*\+\s*\w/i,
  },
  { id: "child-process", label: "Shell/child_process execution", re: /child_process|exec\s*\(/ },
]

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
      "Fast ADVISORY heuristic scan of a code diff for obviously risky patterns (hardcoded secrets, eval, unsafe HTML, SQL concatenation). This is a lightweight pre-PR pre-filter only — it is NOT a substitute for a verified scan. Run lyrashield_run_pr_scan for authoritative, exploit-validated results.",
    inputSchema: {
      type: "object",
      properties: {
        diff: {
          type: "string",
          description: "The unified diff or code snippet to check (added lines are most relevant).",
        },
      },
      required: ["diff"],
    },
    handler: async (args) => {
      void context
      const diff = typeof args.diff === "string" ? args.diff : ""
      if (!diff.trim()) {
        return makeToolResult({ advisory: [], note: "Empty diff — nothing to check." })
      }
      const addedLines = diff
        .split("\n")
        .filter((l) => !l.startsWith("-") && !l.startsWith("@@"))
        .map((l) => (l.startsWith("+") ? l.slice(1) : l))
      const advisory: Array<{ id: string; label: string; line: string }> = []
      for (const line of addedLines) {
        for (const p of DIFF_ADVISORY_PATTERNS) {
          if (p.re.test(line)) {
            advisory.push({ id: p.id, label: p.label, line: line.trim().slice(0, 200) })
          }
        }
      }
      return makeToolResult({
        advisory,
        checked: addedLines.length,
        note:
          advisory.length > 0
            ? "Advisory findings are heuristic and may include false positives. Run lyrashield_run_pr_scan for a verified scan."
            : "No high-signal patterns matched. This does not mean the diff is secure — run lyrashield_run_pr_scan for a verified scan.",
      })
    },
  }
}

export function createRunPrScanTool(context: ToolHandlerContext): McpTool {
  return {
    name: "lyrashield_run_pr_scan",
    mutating: true,
    description:
      "Start a PR-focused security scan (goal CHECK_PR) on a registered target. Provide targetId, or provide repo (owner/repo) and/or auto=true to detect and auto-create a repo target.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: {
          type: "string",
          description: "Target ID (the repo/app to scan, or use repo/auto instead)",
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
          description: "Scan mode: SAFE (default), QUICK, STANDARD, DEEP, or CUSTOM",
        },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const resolved = await resolveTargetId(context, args)
        const data = await apiCall(context, "POST", "/api/scans", {
          workspaceId: args.workspaceId,
          targetId: resolved.targetId,
          goal: "CHECK_PR",
          mode: (args.mode as string) ?? "SAFE",
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
    // Read-only: assembles a remediation plan from the finding's verified
    // detail. Recording it as a proposal is a separate, gated tool
    // (lyrashield_record_fix_proposal) so the common "just show me the plan"
    // call needs no approval.
    name: "lyrashield_generate_fix_plan",
    mutating: false,
    description:
      "Assemble a remediation plan for a finding from its verified detail, recommended fix, and plain-language explanation. Read-only — records nothing. Use lyrashield_record_fix_proposal to persist a proposal on the finding.",
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
      "Record a fix proposal on a finding (the remediation summary you intend to apply). Requires write scope and human approval.",
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
          { workspaceId: args.workspaceId, summary, generatedByModel: "mcp-client" }
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
          { workspaceId: args.workspaceId }
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
      "Assemble a PR-ready security recap (Markdown) for a workspace/target: the launch-readiness verdict plus a severity breakdown of current findings. Read-only — paste the result into a PR comment.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        targetId: { type: "string", description: "Optional target ID to scope the recap" },
      },
      required: ["workspaceId"],
    },
    handler: async (args) => {
      try {
        const wsParam = new URLSearchParams({ workspaceId: args.workspaceId as string })
        if (args.targetId) wsParam.set("targetId", args.targetId as string)

        const [readiness, findings] = await Promise.all([
          apiCall(context, "GET", `/api/launch-readiness?${wsParam.toString()}`),
          apiCall(context, "GET", `/api/findings?${wsParam.toString()}&limit=100`),
        ])

        const readinessObj = (readiness ?? {}) as Record<string, unknown>
        const items = (
          Array.isArray((findings as { items?: unknown[] })?.items)
            ? (findings as { items: Array<Record<string, unknown>> }).items
            : Array.isArray(findings)
              ? (findings as Array<Record<string, unknown>>)
              : []
        ) as Array<Record<string, unknown>>

        const bySeverity: Record<string, number> = {}
        for (const f of items) {
          const sev = String(f.severity ?? "UNKNOWN")
          bySeverity[sev] = (bySeverity[sev] ?? 0) + 1
        }
        const verdict = String(readinessObj.verdict ?? readinessObj.status ?? "UNKNOWN")
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
          sevLines ? `**Open findings by severity:**\n${sevLines}` : `**Open findings:** none`,
          ``,
          `_Findings are verified/exploit-validated. This recap reflects the latest completed scan for this scope._`,
        ].join("\n")

        return makeToolResult({ markdown, verdict, bySeverity, findingCount: items.length })
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
    // Core
    createScanTargetTool(context),
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
