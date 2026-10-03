import {
  analyzeDiffAdvisory,
  DiffAdvisoryInputError,
  DIFF_ADVISORY_LIMITS,
} from "@lyrashield/security/diff-advisory"
import { MCP_RESULT_MAX_BYTES } from "./result-cap"
import {
  apiCall,
  IDEMPOTENCY_KEY_PROPERTY,
  makeErrorResult,
  makeToolResult,
  resolveTargetId,
  workflowInputFields,
  WORKFLOW_INPUT_PROPERTIES,
  type McpTool,
  type McpToolResult,
  type ToolHandlerContext,
} from "./tool-shared"

// Workflow tools support the scan, fix, and verification loop. check_diff and
// the recap are advisory; recorded scans run server-side.

interface CheckDiffFileArg {
  path: string
  content: string
}

function invalidFilesResult(message: string): McpToolResult {
  return makeErrorResult(`Invalid check_diff files: ${message}`)
}

/**
 * Validate the optional `files` input before it reaches the analyzer. Inputs
 * over the shared byte/entry budgets are rejected with a structured tool
 * error instead of being silently truncated.
 */
function parseCheckDiffFiles(value: unknown): {
  files?: CheckDiffFileArg[]
  error?: McpToolResult
} {
  if (value === undefined) return {}
  if (!Array.isArray(value)) {
    return { error: invalidFilesResult("expected an array of {path, content} objects") }
  }
  if (value.length > DIFF_ADVISORY_LIMITS.maxFiles) {
    return {
      error: invalidFilesResult(
        `at most ${DIFF_ADVISORY_LIMITS.maxFiles} file snapshots are accepted; ` +
          `received ${value.length} — supply only the changed files, or run lyrashield_run_pr_scan`
      ),
    }
  }
  const files: CheckDiffFileArg[] = []
  let totalBytes = 0
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return { error: invalidFilesResult("each entry must be a {path, content} object") }
    }
    const { path, content } = entry as Record<string, unknown>
    if (typeof path !== "string" || typeof content !== "string") {
      return { error: invalidFilesResult("each entry must have string path and content") }
    }
    const size = Buffer.byteLength(content)
    totalBytes += size
    if (size > DIFF_ADVISORY_LIMITS.maxFileBytes) {
      return {
        error: invalidFilesResult(
          `${JSON.stringify(path)} exceeds the ${DIFF_ADVISORY_LIMITS.maxFileBytes}-byte per-file limit; ` +
            `run lyrashield_run_pr_scan for a full recorded scan`
        ),
      }
    }
    if (totalBytes > DIFF_ADVISORY_LIMITS.maxTotalBytes) {
      return {
        error: invalidFilesResult(
          `supplied files exceed the ${DIFF_ADVISORY_LIMITS.maxTotalBytes}-byte aggregate limit; ` +
            `supply only the changed files, or run lyrashield_run_pr_scan`
        ),
      }
    }
    files.push({ path, content })
  }
  return { files }
}

/** Serialized size of the complete tool result (text + structured content). */
function checkDiffResultSize(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(makeToolResult(payload)), "utf8")
}

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
      "Fast ADVISORY heuristic scan of a code diff for obviously risky patterns (hardcoded secrets, eval, unsafe HTML, SQL concatenation), plus structural WebMCP checks when optional full-file snapshots are supplied. This is a lightweight pre-PR pre-filter only — it is NOT a substitute for a full recorded scan. Run lyrashield_run_pr_scan for a bounded repository scan with findings, coverage receipts, evidence states and explicit limitations; results are not automatically independently verified or exploit-validated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: {
          type: "string",
          description: "The unified diff or code snippet to check (added lines are most relevant).",
        },
        files: {
          type: "array",
          description:
            "Optional full-file snapshots for the files the diff touches ({path, content}), capped at " +
            `${DIFF_ADVISORY_LIMITS.maxFiles} files / ${DIFF_ADVISORY_LIMITS.maxFileBytes} bytes each / ` +
            `${DIFF_ADVISORY_LIMITS.maxTotalBytes} bytes total. Supplying them enables structural ` +
            "analysis and COMPLETE coverage; omitting them yields advisory pattern checks with " +
            "INCOMPLETE coverage (full-file context not supplied).",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Repo-relative path label (e.g. src/app.ts)." },
              content: { type: "string", description: "Full file contents at the head revision." },
            },
            required: ["path", "content"],
            additionalProperties: false,
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
          coverage: { state: "COMPLETE", scope: "supplied-inputs", reasons: [] },
          note: "Empty diff — nothing to check.",
        })
      }
      const { files, error } = parseCheckDiffFiles(args.files)
      if (error) return error

      let result
      try {
        result = await analyzeDiffAdvisory({ diff, files })
      } catch (err) {
        if (err instanceof DiffAdvisoryInputError) {
          return makeErrorResult(`Invalid check_diff input (${err.reason}): ${err.message}`)
        }
        throw err
      }

      const advisory: Array<Record<string, unknown>> = result.findings.map((finding) => ({
        id: finding.ruleId,
        label: finding.label,
        line: finding.match ?? "",
        severity: finding.severity,
        ...(finding.file !== undefined ? { file: finding.file } : {}),
        ...(finding.line !== undefined ? { lineNumber: finding.line } : {}),
      }))

      let coverage = result.coverage
      const baseNote =
        advisory.length > 0
          ? "Advisory findings are heuristic and may include false positives. Run lyrashield_run_pr_scan for a full recorded scan."
          : "No high-signal patterns matched. This does not mean the diff is secure — run lyrashield_run_pr_scan for a full recorded scan."
      const note =
        coverage.state === "INCOMPLETE"
          ? `${baseNote} Coverage is incomplete (${coverage.reasons.join(
              ", "
            )}): only the supplied inputs were analyzed — pass files:[{path, content}] for fuller context, or run lyrashield_run_pr_scan for a recorded scan of the full change.`
          : baseNote

      // The serialized result must stay under the MCP result cap: shrink the
      // advisory list (never the coverage block) and say so explicitly.
      let bounded = false
      while (advisory.length > 0) {
        const payload: Record<string, unknown> = {
          advisory,
          checked: result.stats.checkedLines,
          coverage,
          note: bounded
            ? `${note} Advisory output was bounded to fit the ${MCP_RESULT_MAX_BYTES}-byte tool result cap — run lyrashield_run_pr_scan for a recorded scan of the full change.`
            : note,
        }
        if (checkDiffResultSize(payload) <= MCP_RESULT_MAX_BYTES) {
          return makeToolResult(payload)
        }
        advisory.length = Math.floor(advisory.length / 2)
        bounded = true
        coverage = {
          state: "INCOMPLETE",
          scope: "supplied-inputs",
          reasons: [...new Set([...coverage.reasons, "result_too_large"])].sort(),
        }
      }
      return makeToolResult({
        advisory: [],
        checked: result.stats.checkedLines,
        coverage,
        note: `${note} Advisory output exceeded the ${MCP_RESULT_MAX_BYTES}-byte tool result cap — run lyrashield_run_pr_scan for a recorded scan of the full change.`,
      })
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
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
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
      additionalProperties: false,
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
      additionalProperties: false,
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
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
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
      additionalProperties: false,
      properties: {
        ...IDEMPOTENCY_KEY_PROPERTY,
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
      additionalProperties: false,
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
