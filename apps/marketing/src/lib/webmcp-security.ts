/// <reference types="webmcp-types" />

import {
  applyWebMcpRewrite,
  generateWebMcpDiff,
  WEBMCP_CONTROLS,
  WEBMCP_CONTROL_IDS,
  WEBMCP_DETECTOR_VERSION,
  type WebMcpControlId,
  type WebMcpCoverageSummary,
  type WebMcpScanFile,
  type WebMcpSignal,
  type WebMcpTextEdit,
  type WebMcpToolInventory,
  type WebMcpRewritePlan,
} from "@lyrashield/security/webmcp"
import { WEBMCP_FREE_LIMITS } from "./webmcp-config"

export { WEBMCP_FREE_LIMITS } from "./webmcp-config"

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".html",
  ".htm",
])

export const UNSAFE_EXAMPLE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Permissions-Policy" content="tools=*">
  <meta http-equiv="Origin-Agent-Cluster" content="?0">
  <title>Unsafe WebMCP sample</title>
</head>
<body>
  <h1>Contact support</h1>
  <form toolname="send_email" tooldescription="Sends a contact email immediately" toolautosubmit>
    <input name="to" type="email" placeholder="Recipient">
    <textarea name="body" placeholder="Message"></textarea>
  </form>

  <iframe src="https://third.party/app" allow="tools"></iframe>

  <script>
    document.domain = "example.com"

    document.modelContext.registerTool({
      name: "delete_user",
      title: "Delete user account",
      description: "Permanently removes a user and all of their data",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to delete" }
        }
      },
      annotations: { readOnlyHint: true },
      exposedTo: ["*"],
      execute: async ({ userId }) => {
        const res = await fetch("/api/users/" + userId, { method: "DELETE" })
        return res.json()
      }
    })
  </script>
</body>
</html>
`

export const SAFE_EXAMPLE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta http-equiv="Permissions-Policy" content="tools=(self)">
  <meta http-equiv="Origin-Agent-Cluster" content="?1">
  <title>Safe WebMCP sample</title>
</head>
<body>
  <form toolname="greet_user" tooldescription="Shows a greeting for the current user">
    <input name="name" type="text" required maxlength="80">
    <button type="submit">Greet</button>
  </form>

  <script>
    const controller = new AbortController()
    const registration = await document.modelContext.registerTool({
      name: "lookup_status",
      title: "Lookup status",
      description: "Returns the current status from a same-origin endpoint",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", maxLength: 64, description: "Session ID" }
        }
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      exposedTo: [],
      execute: async ({ sessionId }, { signal }) => {
        if (typeof sessionId !== "string" || sessionId.length > 64) {
          throw new Error("Invalid sessionId")
        }
        const res = await fetch("/api/status?session=" + encodeURIComponent(sessionId), { signal })
        return res.json()
      }
    })

    window.addEventListener("beforeunload", () => {
      controller.abort()
    })
  </script>
</body>
</html>
`

export async function runLightweightWebMcpDiscovery(_files: WebMcpScanFile[]): Promise<never> {
  throw new Error("Shared WebMCP analyzer unavailable; no fallback result was produced.")
}

function toLanguage(extension: string): WebMcpScanFile["language"] {
  switch (extension.toLowerCase()) {
    case ".js":
      return "javascript"
    case ".jsx":
      return "jsx"
    case ".ts":
      return "typescript"
    case ".tsx":
      return "tsx"
    case ".mjs":
      return "javascript"
    case ".cjs":
      return "javascript"
    case ".astro":
      return "astro"
    case ".html":
    case ".htm":
      return "html"
    default:
      return "unknown"
  }
}

export async function readFilesForWebMcp(files: File[]): Promise<WebMcpScanFile[]> {
  if (files.length > WEBMCP_FREE_LIMITS.maxFiles) {
    throw new Error(`Select at most ${WEBMCP_FREE_LIMITS.maxFiles} files.`)
  }
  const selected: WebMcpScanFile[] = []
  let totalBytes = 0
  for (const file of files) {
    const extension = file.name.slice(file.name.lastIndexOf("."))
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error(`${file.name} is not a supported WebMCP source file.`)
    }
    if (file.size > WEBMCP_FREE_LIMITS.maxFileBytes) {
      throw new Error(`${file.name} exceeds the 1 MiB file limit.`)
    }
    if (totalBytes + file.size > WEBMCP_FREE_LIMITS.maxTotalBytes) {
      throw new Error("Selected files exceed the 5 MiB total limit.")
    }
    const content = await file.text()
    selected.push({
      path: file.name,
      content,
      size: new TextEncoder().encode(content).length,
      extension,
      language: toLanguage(extension),
    })
    totalBytes += file.size
  }
  return selected
}

export function pastedCodeForWebMcp(code: string, extension?: string): WebMcpScanFile {
  const resolvedExtension =
    extension ?? (/^\s*(?:<!doctype|<html|<form|<script|---)/i.test(code) ? ".html" : ".ts")
  const size = new TextEncoder().encode(code).length
  if (size > WEBMCP_FREE_LIMITS.maxFileBytes) {
    throw new Error("Pasted source exceeds the 1 MiB limit.")
  }
  return {
    path: `pasted-code${resolvedExtension}`,
    content: code,
    size,
    extension: resolvedExtension,
    language: toLanguage(resolvedExtension),
  }
}

export type WebMcpUiSignal = {
  controlId: string
  controlTitle: string
  ruleId: string
  state: string
  severity: string
  file?: string
  line?: number
  snippet?: string
  remediation: string
  evidenceSource: string
}

export function toUiSignals(result: { signals: WebMcpSignal[] }): WebMcpUiSignal[] {
  const controlById = new Map(WEBMCP_CONTROLS.map((c) => [c.id, c]))
  return result.signals.map((signal) => {
    const control = controlById.get(signal.controlId)
    return {
      controlId: signal.controlId,
      controlTitle: control?.title ?? signal.controlId,
      ruleId: signal.ruleId,
      state: signal.state,
      severity: signal.severity,
      file: signal.file,
      line: signal.line,
      snippet: signal.snippet,
      remediation: signal.remediation,
      evidenceSource: signal.evidenceSource,
    }
  })
}

export type WebMcpSummary = {
  detected: number
  noFinding: number
  inconclusive: number
  notAssessed: number
  total: number
  controls: Array<{
    id: string
    title: string
    state: string
    signalCount: number
  }>
}

export function buildSummary(result: { coverage: WebMcpCoverageSummary }): WebMcpSummary {
  const controls = WEBMCP_CONTROLS.map((control) => {
    const coverage = result.coverage.controls[control.id]
    return {
      id: control.id,
      title: control.title,
      state: coverage?.state ?? "NOT_ASSESSED",
      signalCount: coverage?.signalCount ?? 0,
    }
  })

  return {
    detected: result.coverage.detectedCount,
    noFinding: result.coverage.noFindingCount,
    inconclusive: result.coverage.inconclusiveCount,
    notAssessed: result.coverage.notAssessedCount,
    total: result.coverage.totalControls,
    controls,
  }
}

export function boundSummary(summary: WebMcpSummary, maxFindings = 6): string {
  const findings = summary.controls.filter(
    (c) => c.state === "DETECTED" || c.state === "INCONCLUSIVE"
  )
  const top = findings.slice(0, maxFindings)
  const lines = [
    `${summary.total} controls assessed: ${summary.detected} detected, ${summary.noFinding} no finding, ${summary.inconclusive} inconclusive, ${summary.notAssessed} not assessed.`,
    ...top.map((c) => `${c.id} · ${c.state} · ${c.title}`),
    findings.length > maxFindings ? `+ ${findings.length - maxFindings} more` : null,
  ].filter(Boolean)
  return lines.join("\n")
}

export type WebMcpExportFormat = "json" | "markdown" | "sarif"

export function exportWebMcpJson(
  state: Pick<WebMcpAnalyzerState, "files" | "inventory" | "signals" | "coverage">
): string {
  return JSON.stringify(
    {
      version: WEBMCP_DETECTOR_VERSION,
      detectorVersion: WEBMCP_DETECTOR_VERSION,
      files: state.files.map((f) => ({
        path: f.path,
        size: f.size,
        extension: f.extension,
        language: f.language,
      })),
      inventory: state.inventory,
      coverage: state.coverage,
      signals: state.signals,
    },
    null,
    2
  )
}

export function exportWebMcpMarkdown(
  state: Pick<WebMcpAnalyzerState, "inventory" | "signals" | "coverage" | "files">
): string {
  const summary = state.coverage ? buildSummary({ coverage: state.coverage }) : null
  const lines: string[] = [
    "# WebMCP Security Check Report",
    "",
    `Detector: ${WEBMCP_DETECTOR_VERSION}`,
    `Files: ${state.files.length}`,
    "",
    "## Coverage summary",
    "",
  ]

  if (summary) {
    lines.push(
      `| Controls | Detected | No finding | Inconclusive | Not assessed |`,
      `| --- | --- | --- | --- | --- |`,
      `| ${summary.total} | ${summary.detected} | ${summary.noFinding} | ${summary.inconclusive} | ${summary.notAssessed} |`,
      ""
    )
    for (const control of summary.controls) {
      lines.push(`- **${control.id}** · ${control.title} · ${control.state}`)
    }
  }

  lines.push("", "## Findings", "")

  if (state.signals.length === 0) {
    lines.push("No signals returned.")
  } else {
    for (const signal of state.signals) {
      const location =
        signal.file && signal.line ? `${signal.file}:${signal.line}` : (signal.file ?? "")
      lines.push(
        `- **${signal.controlId}** · ${signal.ruleId} · ${signal.state} · ${signal.severity}` +
          (location ? ` · ${location}` : "")
      )
      lines.push(`  ${signal.remediation}`)
      if (signal.snippet) {
        lines.push(`  \`\`\`\n  ${signal.snippet.replace(/\n/g, "\n  ")}\n  \`\`\``)
      }
    }
  }

  return lines.join("\n")
}

function sarifLevel(severity: WebMcpSignal["severity"], state: WebMcpSignal["state"]): string {
  if (state === "NO_FINDING" || state === "NOT_ASSESSED") return "none"
  if (state === "INCONCLUSIVE") return "warning"
  if (severity === "CRITICAL" || severity === "HIGH") return "error"
  if (severity === "MEDIUM" || severity === "LOW") return "warning"
  return "note"
}

export function exportWebMcpSarif(
  state: Pick<WebMcpAnalyzerState, "signals" | "coverage" | "files">
): string {
  const rules = WEBMCP_CONTROLS.map((control) => ({
    id: control.id,
    name: control.title,
    shortDescription: { text: control.description },
    helpUri: `https://lyrashieldai.com/webmcp#${control.id.toLowerCase()}`,
    properties: {
      tags: ["webmcp"],
      precision: "high",
    },
  }))

  const results = state.signals
    .filter((s) => s.state === "DETECTED" || s.state === "INCONCLUSIVE")
    .map((signal) => ({
      ruleId: signal.controlId,
      ruleIndex: rules.findIndex((r) => r.id === signal.controlId),
      message: { text: signal.remediation },
      level: sarifLevel(signal.severity, signal.state),
      locations: signal.file
        ? [
            {
              physicalLocation: {
                artifactLocation: { uri: signal.file },
                region: signal.line
                  ? { startLine: signal.line, snippet: { text: signal.snippet ?? "" } }
                  : undefined,
              },
            },
          ]
        : [],
      properties: {
        state: signal.state,
        severity: signal.severity,
        evidenceSource: signal.evidenceSource,
        detectorVersion: signal.detectorVersion,
      },
    }))

  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "LyraShield WebMCP Security Checker",
              version: WEBMCP_DETECTOR_VERSION,
              rules,
            },
          },
          results,
          invocations: [
            {
              executionSuccessful: true,
              properties: {
                detectorVersion: WEBMCP_DETECTOR_VERSION,
                controlsAssessed: state.coverage?.assessedCount ?? 0,
              },
            },
          ],
        },
      ],
    },
    null,
    2
  )
}

export interface WebMcpAnalyzeResult {
  inventory: WebMcpToolInventory
  signals: WebMcpSignal[]
  coverage: WebMcpCoverageSummary
}

interface WorkerRequest {
  id: string
  type: "analyze" | "prepareRewrite"
  files: WebMcpScanFile[]
  selectedControlIds?: WebMcpControlId[]
  signals?: WebMcpSignal[]
}

interface WorkerAnalyzeResponse {
  id: string
  type: "analyze"
  result: WebMcpAnalyzeResult
}

interface WorkerRewriteResponse {
  id: string
  type: "prepareRewrite"
  plan: WebMcpRewritePlan
}

interface WorkerErrorResponse {
  id: string
  type: "error"
  message: string
}

type WorkerResponse = WorkerAnalyzeResponse | WorkerRewriteResponse | WorkerErrorResponse

class WebMcpWorker {
  private worker: Worker | null = null
  private pending = new Map<
    string,
    { resolve: (value: WorkerResponse) => void; reject: (reason: Error) => void }
  >()
  private workerFactory: () => Worker

  constructor(workerFactory: () => Worker) {
    this.workerFactory = workerFactory
  }

  private rejectPending(error: Error) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.reject(error)
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    this.worker = this.workerFactory()
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.type === "error") {
        pending.reject(new Error(response.message))
      } else {
        pending.resolve(response)
      }
    }
    this.worker.onerror = (error) => {
      this.rejectPending(new Error(error.message || "WebMCP worker failed"))
    }
    return this.worker
  }

  private post(message: WorkerRequest, signal?: AbortSignal): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("WebMCP analysis cancelled", "AbortError"))
        return
      }
      const onAbort = () => {
        this.worker?.terminate()
        this.worker = null
        this.rejectPending(new DOMException("WebMCP analysis cancelled", "AbortError"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(message.id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      this.ensureWorker().postMessage(message)
    })
  }

  async analyze(files: WebMcpScanFile[], signal?: AbortSignal): Promise<WebMcpAnalyzeResult> {
    const id = globalThis.crypto.randomUUID()
    const response = await this.post({ id, type: "analyze", files }, signal)
    if (response.type !== "analyze") throw new Error("Unexpected worker response")
    return response.result
  }

  async prepareRewrite(
    files: WebMcpScanFile[],
    signals: WebMcpSignal[],
    selectedControlIds: WebMcpControlId[],
    signal?: AbortSignal
  ): Promise<WebMcpRewritePlan> {
    const id = globalThis.crypto.randomUUID()
    const response = await this.post(
      {
        id,
        type: "prepareRewrite",
        files,
        signals,
        selectedControlIds,
      },
      signal
    )
    if (response.type !== "prepareRewrite") throw new Error("Unexpected worker response")
    return response.plan
  }

  terminate() {
    this.worker?.terminate()
    this.worker = null
    this.rejectPending(new Error("Worker terminated"))
  }
}

export class WebMcpAnalyzerState {
  private worker: WebMcpWorker
  private originalFiles: WebMcpScanFile[] = []

  files: WebMcpScanFile[] = []
  inventory: WebMcpToolInventory | null = null
  signals: WebMcpSignal[] = []
  coverage: WebMcpCoverageSummary | null = null
  selectedControlIds: Set<WebMcpControlId> = new Set()
  rewritePlan: WebMcpRewritePlan | null = null
  canUndo = false
  busy = false
  error: string | null = null
  onChange?: () => void

  constructor(workerFactory: () => Worker) {
    this.worker = new WebMcpWorker(workerFactory)
  }

  private notify() {
    this.onChange?.()
  }

  setError(message: string) {
    this.error = message
    this.busy = false
    this.notify()
  }

  setFiles(files: WebMcpScanFile[]) {
    this.files = files
    this.originalFiles = files.map((f) => ({ ...f, content: f.content }))
    this.signals = []
    this.coverage = null
    this.inventory = null
    this.rewritePlan = null
    this.canUndo = false
    this.error = null
    this.notify()
  }

  loadUnsafeSample() {
    this.setFiles([pastedCodeForWebMcp(UNSAFE_EXAMPLE, ".html")])
  }

  loadSafeSample() {
    this.setFiles([pastedCodeForWebMcp(SAFE_EXAMPLE, ".html")])
  }

  async analyze(signal?: AbortSignal) {
    this.busy = true
    this.error = null
    this.rewritePlan = null
    this.notify()
    try {
      const result = await this.worker.analyze(this.files, signal)
      this.inventory = result.inventory
      this.signals = result.signals
      this.coverage = result.coverage
      this.error = null
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.busy = false
      this.notify()
    }
  }

  toggleControl(controlId: WebMcpControlId) {
    if (this.selectedControlIds.has(controlId)) {
      this.selectedControlIds.delete(controlId)
    } else {
      this.selectedControlIds.add(controlId)
    }
    this.notify()
  }

  async prepareRewrite(signal?: AbortSignal) {
    if (this.selectedControlIds.size === 0 || this.signals.length === 0) return
    this.busy = true
    this.error = null
    this.notify()
    try {
      const plan = await this.worker.prepareRewrite(
        this.files,
        this.signals,
        [...this.selectedControlIds],
        signal
      )
      this.rewritePlan = plan
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.busy = false
      this.notify()
    }
  }

  async applyRewrite(signal?: AbortSignal) {
    if (!this.rewritePlan || this.rewritePlan.edits.length === 0) return
    const grouped = new Map<string, WebMcpTextEdit[]>()
    for (const edit of this.rewritePlan.edits) {
      const path = edit.path ?? this.files[0]?.path ?? ""
      const list = grouped.get(path) ?? []
      list.push(edit)
      grouped.set(path, list)
    }

    this.files = this.files.map((file) => {
      const edits = grouped.get(file.path)
      if (!edits) return file
      return { ...file, content: applyWebMcpRewrite(file.content, edits) }
    })

    this.canUndo = true
    await this.analyze(signal)
  }

  async undoRewrite(signal?: AbortSignal) {
    this.files = this.originalFiles.map((f) => ({ ...f, content: f.content }))
    this.rewritePlan = null
    this.canUndo = false
    await this.analyze(signal)
  }

  async rerun(signal?: AbortSignal) {
    this.originalFiles = this.files.map((f) => ({ ...f, content: f.content }))
    this.canUndo = false
    await this.analyze(signal)
  }

  getRewriteDiff(): string | null {
    if (!this.rewritePlan) return null
    const grouped = new Map<string, WebMcpTextEdit[]>()
    for (const edit of this.rewritePlan.edits) {
      const path = edit.path ?? this.files[0]?.path ?? ""
      const list = grouped.get(path) ?? []
      list.push(edit)
      grouped.set(path, list)
    }

    const parts: string[] = []
    for (const [path, edits] of grouped) {
      const file = this.files.find((f) => f.path === path)
      if (!file) continue
      const after = applyWebMcpRewrite(file.content, edits)
      parts.push(`--- ${path}\n${generateWebMcpDiff(file.content, after)}`)
    }
    return parts.join("\n")
  }

  terminate() {
    this.worker.terminate()
  }
}

export type WebMcpToolDefinition = WebMCP.ModelContextTool

export interface WebMcpPublicActivity {
  toolName: string
  status: "running" | "completed" | "cancelled" | "failed"
  startedAt: string
  endedAt?: string
}

export function registerWebMcpTools(
  state: WebMcpAnalyzerState,
  signal: AbortSignal,
  onActivity?: (activity: WebMcpPublicActivity) => void
): Promise<void>[] | null {
  const modelContext = document.modelContext
  if (!modelContext) return null

  const tools: WebMcpToolDefinition[] = [
    {
      name: "analyze_webmcp_source",
      title: "Analyze WebMCP source",
      description:
        "Analyzes the current local files or pasted code and returns a bounded WebMCP assurance summary with control states.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Use the current input or load the unsafe sample.",
            enum: ["current", "unsafe_sample"],
          },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (
        input: Record<string, unknown>,
        options: WebMCP.ToolExecuteCallbackOptions
      ) => {
        if (Object.keys(input).some((key) => key !== "source")) {
          return { error: "Unknown input parameter." }
        }
        const source = input.source as string | undefined
        if (source !== undefined && source !== "current" && source !== "unsafe_sample") {
          return { error: "source must be current or unsafe_sample." }
        }
        if (source === "unsafe_sample") {
          state.loadUnsafeSample()
        }
        if (state.files.length === 0 && source !== "unsafe_sample") {
          return { error: "No source loaded. Paste or select files first." }
        }
        await state.analyze(options.signal)
        if (options.signal.aborted) return { error: "Analysis cancelled.", cancelled: true }
        if (state.error) return { error: state.error }
        return {
          summary: state.coverage
            ? boundSummary(buildSummary({ coverage: state.coverage }))
            : "No summary available.",
          detectorVersion: WEBMCP_DETECTOR_VERSION,
        }
      },
    },
    {
      name: "prepare_webmcp_rewrite",
      title: "Prepare WebMCP rewrite",
      description:
        "Prepares a bounded rewrite plan for the selected WebMCP finding. Source and diff stay in the human UI.",
      inputSchema: {
        type: "object",
        properties: {
          controlId: {
            type: "string",
            description: "Control ID to prepare a rewrite for (e.g. WEBMCP-03).",
          },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (
        input: Record<string, unknown>,
        options: WebMCP.ToolExecuteCallbackOptions
      ) => {
        if (Object.keys(input).some((key) => key !== "controlId")) {
          return { error: "Unknown input parameter." }
        }
        if (state.files.length === 0) return { error: "No source loaded." }
        const controlId = input.controlId as WebMcpControlId | undefined
        if (!controlId || !WEBMCP_CONTROL_IDS.includes(controlId)) {
          return { error: `Unknown control ID. Valid IDs: ${WEBMCP_CONTROL_IDS.join(", ")}` }
        }
        const hasFinding = state.signals.some(
          (s) => s.controlId === controlId && s.state === "DETECTED"
        )
        if (!hasFinding) {
          return { error: `No DETECTED signal for ${controlId}.` }
        }
        state.selectedControlIds.clear()
        state.selectedControlIds.add(controlId)
        await state.prepareRewrite(options.signal)
        if (options.signal.aborted)
          return { error: "Rewrite preparation cancelled.", cancelled: true }
        return {
          controlId,
          addressed: state.rewritePlan?.addressed ?? [],
          unresolved: state.rewritePlan?.unresolved ?? [],
          warningCount: state.rewritePlan?.warnings.length ?? 0,
          rewritePrepared: (state.rewritePlan?.edits.length ?? 0) > 0,
          applyRequiredHumanReview: true,
        }
      },
    },
  ]

  const registrations = tools.map((tool) => {
    const execute = tool.execute
    const registeredTool: WebMcpToolDefinition = {
      ...tool,
      execute: async (input, options) => {
        const startedAt = new Date().toISOString()
        onActivity?.({ toolName: tool.name, status: "running", startedAt })
        try {
          const result = await execute(input, options)
          const output = result as { cancelled?: unknown; error?: unknown }
          const status = output.cancelled ? "cancelled" : output.error ? "failed" : "completed"
          onActivity?.({
            toolName: tool.name,
            status,
            startedAt,
            endedAt: new Date().toISOString(),
          })
          return result
        } catch (error) {
          onActivity?.({
            toolName: tool.name,
            status: options.signal.aborted ? "cancelled" : "failed",
            startedAt,
            endedAt: new Date().toISOString(),
          })
          throw error
        }
      },
    }
    return modelContext.registerTool(registeredTool, { signal })
  })

  signal.addEventListener("abort", () => {
    state.terminate()
  })

  return registrations
}
