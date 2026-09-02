import { WEBMCP_CONTROLS_BY_ID, WEBMCP_CONTROL_IDS, WEBMCP_CONTROLS } from "./controls"
import {
  buildSignal,
  detectedSignal,
  inconclusiveSignal,
  getLineAt,
  noFindingSignal,
  notAssessedSignal,
} from "./utils"
import { WEBMCP_DETECTOR_VERSION } from "./types"
import type {
  WebMcpControlId,
  WebMcpControlCoverage,
  WebMcpCoverageSummary,
  WebMcpEvaluateContext,
  WebMcpEvidenceState,
  WebMcpScanFile,
  WebMcpScanLimit,
  WebMcpSeverity,
  WebMcpSignal,
  WebMcpToolInventory,
  WebMcpToolSurface,
  WebMcpEvidenceLocation,
} from "./types"

function findFile(files: WebMcpScanFile[], path: string): WebMcpScanFile | undefined {
  return files.find((f) => f.path === path)
}

function fileForTool(files: WebMcpScanFile[], tool: WebMcpToolSurface): WebMcpScanFile {
  return (
    findFile(files, tool.source.path) ?? {
      path: tool.source.path,
      content: "",
      size: 0,
      extension: "",
    }
  )
}

function lineStartIndex(content: string, line: number): number {
  let current = 1
  for (let i = 0; i < content.length; i++) {
    if (current === line) return i
    if (content[i] === "\n") current++
  }
  return content.length
}

function toolRange(tool: WebMcpToolSurface, file: WebMcpScanFile): { start: number; end: number } {
  const start = lineStartIndex(file.content, tool.source.startLine)
  const end = lineStartIndex(file.content, tool.source.endLine + 1)
  return { start, end: Math.min(end, file.content.length) }
}

function toolSignal(
  controlId: WebMcpControlId,
  ruleId: string,
  state: WebMcpEvidenceState,
  tool: WebMcpToolSurface,
  files: WebMcpScanFile[],
  options?: { overrideRemediation?: string; overrideSeverity?: WebMcpSeverity }
): WebMcpSignal {
  const file = fileForTool(files, tool)
  const { start, end } = toolRange(tool, file)
  if (state === "DETECTED") {
    return detectedSignal(controlId, ruleId, file, { start, end, ...options })
  }
  if (state === "NO_FINDING") {
    return noFindingSignal(controlId, ruleId, file)
  }
  if (state === "INCONCLUSIVE") {
    return inconclusiveSignal(
      controlId,
      ruleId,
      file,
      options?.overrideRemediation ?? "Coverage is incomplete for this control."
    )
  }
  return notAssessedSignal(controlId, ruleId, file, "This control was not assessed for this tool.")
}

function evaluateControl01(tool: WebMcpToolSurface): WebMcpEvidenceState {
  const { readOnlyHint, untrustedContentHint } = tool.annotations
  if (readOnlyHint === true && (tool.behavior === "mutation" || tool.behavior === "ui-only")) {
    return "DETECTED"
  }
  if (readOnlyHint === true && tool.networkMethods.length > 0 && tool.behavior === "unknown") {
    return "INCONCLUSIVE"
  }
  if (readOnlyHint === true && tool.behavior === "unknown") {
    return "INCONCLUSIVE"
  }
  if (untrustedContentHint === false && tool.returnsExternalContent === true) {
    return "DETECTED"
  }
  if (readOnlyHint === null && untrustedContentHint === null && tool.behavior === "unknown") {
    return "INCONCLUSIVE"
  }
  return "NO_FINDING"
}

function evaluateControl02(tool: WebMcpToolSurface): WebMcpEvidenceState {
  if (tool.returnsExternalContent === true && tool.annotations.untrustedContentHint !== true) {
    return "DETECTED"
  }
  if (tool.returnsExternalContent === null) {
    return "INCONCLUSIVE"
  }
  return "NO_FINDING"
}

function evaluateControl03(tool: WebMcpToolSurface): WebMcpEvidenceState {
  if (tool.exposedTo === "dynamic") {
    return "INCONCLUSIVE"
  }
  if (Array.isArray(tool.exposedTo)) {
    if (tool.exposedTo.length === 0) return "NO_FINDING"
    return "DETECTED"
  }
  return "NO_FINDING"
}

function evaluateControl05(tool: WebMcpToolSurface): WebMcpEvidenceState {
  if (tool.behavior === "mutation") {
    return "DETECTED"
  }
  if (
    tool.behavior === "unknown" &&
    tool.networkMethods.some((m) => m === "POST" || m === "DELETE" || m === "PUT" || m === "PATCH")
  ) {
    return "INCONCLUSIVE"
  }
  if (tool.behavior === "unknown") return "INCONCLUSIVE"
  return "NO_FINDING"
}

const SENSITIVE_PARAMETER_NAMES =
  /\b(token|password|secret|api[_-]?key|credential|private[_-]?key)\b/i

function evaluateControl06(tool: WebMcpToolSurface): WebMcpEvidenceState {
  const schema = tool.inputSchema
  if (schema.type === "object" && schema.properties) {
    const sensitive = schema.properties.filter(
      (p) => SENSITIVE_PARAMETER_NAMES.test(p.name) && !p.description
    )
    if (sensitive.length > 0) return "DETECTED"

    const unbounded = schema.properties.filter(
      (p) => (p.type === "string" || p.type === "array" || p.type === "object") && !p.bounded
    )
    // DEVIN: unbounded properties are a finding even when additionalProperties is
    // explicitly false. A closed object schema does not bound individual fields.
    if (unbounded.length > 0) return "DETECTED"
    if (schema.additionalProperties === true) return "DETECTED"
    if (schema.additionalProperties === "unknown") return "INCONCLUSIVE"
  }
  if (schema.type === "unknown" || schema.type === "any") {
    return "INCONCLUSIVE"
  }
  if (
    tool.networkMethods.length > 0 &&
    tool.returnsExternalContent === true &&
    !tool.annotations.untrustedContentHint
  ) {
    return "DETECTED"
  }
  return "NO_FINDING"
}

function evaluateControl07(tool: WebMcpToolSurface): WebMcpEvidenceState {
  if (tool.networkMethods.length === 0) return "NO_FINDING"
  if (tool.forwardsCancellation === false) return "DETECTED"
  if (tool.forwardsCancellation === null) return "INCONCLUSIVE"
  return "NO_FINDING"
}

function evaluateControl08(tool: WebMcpToolSurface): WebMcpEvidenceState {
  if (tool.kind === "declarative") return "NO_FINDING"
  if (tool.hasRegistrationCleanup === false) return "DETECTED"
  if (tool.hasRegistrationCleanup === null) return "INCONCLUSIVE"
  return "NO_FINDING"
}

function evaluateControl09(tool: WebMcpToolSurface): WebMcpEvidenceState {
  const schema = tool.inputSchema
  if (schema.type === "object") {
    if (tool.runtimeValidation === "absent") return "DETECTED"
    if (schema.additionalProperties === true) return "DETECTED"
    if (schema.additionalProperties === "unknown" || tool.runtimeValidation === "unknown")
      return "INCONCLUSIVE"
  }
  if (tool.runtimeValidation === "present") return "NO_FINDING"
  if (schema.type === "unknown" || schema.type === "any") return "INCONCLUSIVE"
  return "NO_FINDING"
}

// WEBMCP-11: a credential embedded in the tool's own name/title/description or
// schema. Literal credential values only — an empty input parameter the caller
// fills is not a leak (see the control's falsePositiveNotes). Two assignment
// forms are covered: quoted values ("key": "sk-...") and unquoted ones
// (DATABASE_URL=postgres://user:pw@host/db, api_key=AKIA...), since tool
// descriptions frequently embed connection strings and env-style examples.
const EMBEDDED_SECRET_QUOTED =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:api[_-]?key|api[_-]?secret|password|secret|token|credential)\s*[:=]\s*["'][^"'\s]{8,}["']/i
const EMBEDDED_SECRET_UNQUOTED =
  /\b(?:api[_-]?key|api[_-]?secret|password|secret|token|credential)[_a-z0-9]*\s*[:=]\s*[A-Za-z0-9+/_=.\-:]{20,}/i
// A database/connection URI carrying inline credentials (scheme://user:pass@).
// The user:pass@ shape is what makes it a secret; credential-free URLs
// (https://example.com) do not match.
const EMBEDDED_SECRET_CONN_URI =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|ftp):\/\/[A-Za-z0-9_.-]+:[^@\s/]{4,}@/i

function evaluateControl11(tool: WebMcpToolSurface): WebMcpEvidenceState {
  const text = [tool.name, tool.title, tool.description].filter(Boolean).join("\n")
  const schemaText = (tool.inputSchema.properties ?? [])
    .map((p) => `${p.name} ${p.description ?? ""}`)
    .join("\n")
  const haystack = `${text}\n${schemaText}`
  if (EMBEDDED_SECRET_QUOTED.test(haystack)) return "DETECTED"
  if (EMBEDDED_SECRET_UNQUOTED.test(haystack)) return "DETECTED"
  if (EMBEDDED_SECRET_CONN_URI.test(haystack)) return "DETECTED"
  return "NO_FINDING"
}

// WEBMCP-12: instruction-shaped text aimed at the consuming model in the tool
// contract — the tool surface as a prompt-injection vector. The filler group
// uses literal single spaces (no quantifiers inside the repeated group) to stay
// clear of the unsafe-regex lint and any ReDoS surface. The separator class
// accepts [-_ ] because instruction-shaped TOOL NAMES are identifier-like
// ("ignore-previous-instructions", "ignore_previous_instructions") — the
// control's surface includes the tool name.
const PROMPT_INJECTION_SURFACE =
  /\b(ignore|disregard|forget|override)[-_ ](?:all[-_ ]|any[-_ ]|every[-_ ]|the[-_ ]|your[-_ ]|previous[-_ ]|prior[-_ ]|above[-_ ]|earlier[-_ ]|system[-_ ]){0,3}(instructions|prompts|rules|directives|guardrails)\b|\byou (must|should|will|shall) (always|never)\b|\bsystem prompt\b|\bas an? (ai|language model)\b|\bdo not tell the user\b/i

function evaluateControl12(tool: WebMcpToolSurface): WebMcpEvidenceState {
  // The control's text covers "name, title, description" — the tool name is
  // part of the model-visible contract, so an instruction-shaped name
  // (e.g. "ignore-previous-instructions") must be scanned too.
  const text = [tool.name, tool.title, tool.description].filter(Boolean).join("\n")
  if (PROMPT_INJECTION_SURFACE.test(text)) return "DETECTED"
  return "NO_FINDING"
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/

function evaluateControl14(tool: WebMcpToolSurface): WebMcpEvidenceState {
  if (!tool.name) return "INCONCLUSIVE"
  if (!TOOL_NAME.test(tool.name) || tool.name.length > 30) return "DETECTED"
  if (!tool.description || tool.description.length > 500) return "DETECTED"
  for (const property of tool.inputSchema.properties ?? []) {
    if (property.name.length > 30 || (property.description?.length ?? 0) > 150) {
      return "DETECTED"
    }
  }
  return "NO_FINDING"
}

function evaluateTool(
  tool: WebMcpToolSurface,
  files: WebMcpScanFile[],
  controlId: WebMcpControlId
): WebMcpSignal {
  let state: WebMcpEvidenceState = "NOT_ASSESSED"
  switch (controlId) {
    case "WEBMCP-01":
      state = evaluateControl01(tool)
      break
    case "WEBMCP-02":
      state = evaluateControl02(tool)
      break
    case "WEBMCP-03":
      state = evaluateControl03(tool)
      break
    case "WEBMCP-05":
      state = evaluateControl05(tool)
      break
    case "WEBMCP-06":
      state = evaluateControl06(tool)
      break
    case "WEBMCP-07":
      state = evaluateControl07(tool)
      break
    case "WEBMCP-08":
      state = evaluateControl08(tool)
      break
    case "WEBMCP-09":
      state = evaluateControl09(tool)
      break
    case "WEBMCP-11":
      state = evaluateControl11(tool)
      break
    case "WEBMCP-12":
      state = evaluateControl12(tool)
      break
    case "WEBMCP-14":
      state = evaluateControl14(tool)
      break
    default:
      state = "NOT_ASSESSED"
  }
  return toolSignal(controlId, `${controlId}.${ruleSuffix(controlId)}`, state, tool, files)
}

function ruleSuffix(controlId: WebMcpControlId): string {
  switch (controlId) {
    case "WEBMCP-01":
      return "annotation-behavior-mismatch"
    case "WEBMCP-02":
      return "untrusted-content"
    case "WEBMCP-03":
      return "cross-origin-exposure"
    case "WEBMCP-05":
      return "missing-confirmation"
    case "WEBMCP-06":
      return "unbounded-contract"
    case "WEBMCP-07":
      return "missing-cancellation"
    case "WEBMCP-08":
      return "missing-cleanup"
    case "WEBMCP-09":
      return "weak-schema"
    case "WEBMCP-11":
      return "embedded-secret"
    case "WEBMCP-12":
      return "prompt-injection-surface"
    case "WEBMCP-14":
      return "contract-budget"
    default:
      return "signal"
  }
}

function evaluateControl13(
  files: WebMcpScanFile[],
  context: WebMcpEvaluateContext
): WebMcpSignal[] {
  const findings = context.specDrift?.findings ?? []
  if (findings.length === 0) {
    return [
      noFindingSignal(
        "WEBMCP-13",
        "WEBMCP-13.current-api",
        files[0] ?? { path: "inventory", content: "", size: 0, extension: "" }
      ),
    ]
  }
  return findings.map((finding) => {
    const file = findFile(files, finding.path) ?? {
      path: finding.path,
      content: "",
      size: 0,
      extension: "",
    }
    return buildSignal("WEBMCP-13", finding.ruleId, "DETECTED", file, {
      line: finding.startLine,
      endLine: finding.endLine,
      snippet: getLineAt(file.content, finding.startLine).slice(0, 120),
    })
  })
}

function evaluateControl04(
  files: WebMcpScanFile[],
  context: WebMcpEvaluateContext,
  exposure?: WebMcpToolSurface
): WebMcpSignal[] {
  const exposureFile = exposure
    ? fileForTool(files, exposure)
    : (files[0] ?? { path: "config-exposure", content: "", size: 0, extension: "" })
  const meta = context.headerExposure
  if (!meta) {
    return [noFindingSignal("WEBMCP-04", "WEBMCP-04.unsafe-permissions", exposureFile)]
  }
  const findings: WebMcpSignal[] = []
  const evidenceSignal = (
    ruleId: string,
    location: WebMcpEvidenceLocation | undefined
  ): WebMcpSignal => {
    const file = location ? (findFile(files, location.path) ?? exposureFile) : exposureFile
    return buildSignal("WEBMCP-04", ruleId, "DETECTED", file, {
      line: location?.startLine,
      endLine: location?.endLine,
      snippet: location ? getLineAt(file.content, location.startLine).slice(0, 120) : undefined,
    })
  }
  const evidence = meta.evidence
  if (meta.hasWildcardToolsPolicy === true) {
    findings.push(
      evidenceSignal("WEBMCP-04.wildcard-permissions-policy", evidence?.unsafeToolsPolicy?.[0])
    )
  }
  if (meta.hasDocumentDomain === true) {
    findings.push(evidenceSignal("WEBMCP-04.document-domain", evidence?.documentDomain?.[0]))
  }
  if (meta.hasDelegatedToolsIframe === true) {
    findings.push(evidenceSignal("WEBMCP-04.delegated-iframe", evidence?.delegatedToolsIframe?.[0]))
  }
  if (meta.hasOriginAgentCluster === false) {
    findings.push(
      evidenceSignal(
        "WEBMCP-04.origin-agent-cluster-disabled",
        evidence?.originAgentClusterDisabled?.[0]
      )
    )
  }
  if (findings.length === 0) {
    const file = exposureFile
    const state: WebMcpEvidenceState =
      meta.hasOriginAgentCluster === null || meta.hasToolsSelfPolicy === null
        ? "INCONCLUSIVE"
        : "NO_FINDING"
    const remediation =
      state === "INCONCLUSIVE"
        ? "Exposure metadata is incomplete; review Origin-Agent-Cluster and Permissions-Policy configuration manually."
        : WEBMCP_CONTROLS_BY_ID["WEBMCP-04"].remediationTemplate
    findings.push(
      buildSignal("WEBMCP-04", "WEBMCP-04.unsafe-permissions", state, file, {
        overrideRemediation: remediation,
      })
    )
  }
  return findings
}

function evaluateControl10(
  files: WebMcpScanFile[],
  definitions: WebMcpToolSurface[]
): WebMcpSignal[] {
  if (definitions.length === 0) {
    return []
  }
  const file = files[0] ?? { path: "inventory", content: "", size: 0, extension: "" }
  const nameCounts = new Map<string, number>()
  const seenTitles = new Set<string>()
  const seenDescriptions = new Set<string>()
  const duplicates: string[] = []
  const results: WebMcpSignal[] = []

  for (const tool of definitions) {
    if (tool.name === null) {
      results.push(
        inconclusiveSignal(
          "WEBMCP-10",
          "WEBMCP-10.dynamic-name",
          file,
          `Tool with dynamic name in ${tool.source.path} cannot be checked for uniqueness.`
        )
      )
      continue
    }
    const count = (nameCounts.get(tool.name) ?? 0) + 1
    nameCounts.set(tool.name, count)
    if (count === 2) duplicates.push(tool.name)

    if (tool.title && seenTitles.has(tool.title)) {
      results.push(
        toolSignal("WEBMCP-10", "WEBMCP-10.duplicate-title", "DETECTED", tool, files, {
          overrideRemediation: `Tool title "${tool.title}" is used by more than one tool.`,
        })
      )
    }
    if (tool.title) seenTitles.add(tool.title)

    if (tool.description && seenDescriptions.has(tool.description)) {
      results.push(
        toolSignal("WEBMCP-10", "WEBMCP-10.duplicate-description", "DETECTED", tool, files, {
          overrideRemediation: `Tool description is identical to another tool.`,
        })
      )
    }
    if (tool.description) seenDescriptions.add(tool.description)
  }

  for (const tool of definitions) {
    if (tool.name && duplicates.includes(tool.name)) {
      results.push(
        toolSignal("WEBMCP-10", "WEBMCP-10.duplicate-name", "DETECTED", tool, files, {
          overrideRemediation: `Tool name "${tool.name}" is used by more than one definition.`,
        })
      )
    }
  }

  if (results.length === 0) {
    return [noFindingSignal("WEBMCP-10", "WEBMCP-10.duplicate-name", file)]
  }
  return results
}

export function evaluateWebMcpSurface(
  files: WebMcpScanFile[],
  inventory: WebMcpToolInventory,
  context?: WebMcpEvaluateContext
): WebMcpSignal[] {
  const signals: WebMcpSignal[] = []
  const partialCoverage =
    inventory.incompleteDefinitions > 0 ||
    inventory.limitsReached.length > 0 ||
    inventory.truncatedFiles.length > 0
  const partialReason =
    "WebMCP discovery was incomplete; clean results cannot be established until all eligible definitions are assessed."

  if (inventory.definitions.length === 0 && !context?.headerExposure && !context?.specDrift) {
    for (const controlId of WEBMCP_CONTROL_IDS) {
      const file = files[0] ?? { path: "inventory", content: "", size: 0, extension: "" }
      signals.push(
        partialCoverage
          ? inconclusiveSignal(controlId, `${controlId}.partial-coverage`, file, partialReason)
          : notAssessedSignal(
              controlId,
              `${controlId}.no-definitions`,
              file,
              "No tool definitions were discovered."
            )
      )
    }
    return signals
  }

  if (inventory.definitions.length === 0) {
    // Header/config exposure can still be assessed when no tools are defined.
    for (const controlId of WEBMCP_CONTROL_IDS) {
      if (controlId === "WEBMCP-04" || controlId === "WEBMCP-13") continue
      const file = files[0] ?? { path: "inventory", content: "", size: 0, extension: "" }
      signals.push(
        notAssessedSignal(
          controlId,
          `${controlId}.no-definitions`,
          file,
          "No tool definitions were discovered."
        )
      )
    }
    signals.push(...evaluateControl04(files, context ?? {}))
    signals.push(...evaluateControl13(files, context ?? {}))
    return signals
  }

  for (const tool of inventory.definitions) {
    for (const controlId of WEBMCP_CONTROL_IDS) {
      if (controlId === "WEBMCP-04" || controlId === "WEBMCP-10" || controlId === "WEBMCP-13")
        continue
      signals.push(evaluateTool(tool, files, controlId))
    }
  }

  signals.push(...evaluateControl04(files, context ?? {}))
  signals.push(...evaluateControl10(files, inventory.definitions))
  signals.push(...evaluateControl13(files, context ?? {}))

  if (partialCoverage) {
    const file = files[0] ?? { path: "inventory", content: "", size: 0, extension: "" }
    for (const controlId of WEBMCP_CONTROL_IDS) {
      signals.push(
        inconclusiveSignal(controlId, `${controlId}.partial-coverage`, file, partialReason)
      )
    }
  }

  return signals
}

export function summarizeWebMcpCoverage(
  signals: WebMcpSignal[],
  limits: WebMcpScanLimit[] = []
): WebMcpCoverageSummary {
  const controls: Record<WebMcpControlId, WebMcpControlCoverage> = {} as Record<
    WebMcpControlId,
    WebMcpControlCoverage
  >
  for (const control of WEBMCP_CONTROLS) {
    controls[control.id] = {
      controlId: control.id,
      state: "NOT_ASSESSED",
      assessed: false,
      ruleIds: [],
      fileCount: 0,
      signalCount: 0,
    }
  }

  const byControl = new Map<WebMcpControlId, WebMcpSignal[]>()
  for (const signal of signals) {
    const list = byControl.get(signal.controlId) ?? []
    list.push(signal)
    byControl.set(signal.controlId, list)
  }

  for (const controlId of WEBMCP_CONTROL_IDS) {
    const list = byControl.get(controlId) ?? []
    const ruleIds = [...new Set(list.map((s) => s.ruleId))]
    const files = new Set(list.map((s) => s.file).filter(Boolean))
    let state: WebMcpEvidenceState = "NOT_ASSESSED"
    if (list.some((s) => s.state === "DETECTED")) state = "DETECTED"
    else if (list.some((s) => s.state === "INCONCLUSIVE")) state = "INCONCLUSIVE"
    else if (list.some((s) => s.state === "NO_FINDING")) state = "NO_FINDING"
    else if (list.some((s) => s.state === "NOT_ASSESSED")) state = "NOT_ASSESSED"

    controls[controlId] = {
      controlId,
      state,
      assessed: state !== "NOT_ASSESSED",
      ruleIds,
      fileCount: files.size,
      signalCount: list.length,
    }
  }

  const allStates = Object.values(controls).map((c) => c.state)
  return {
    version: WEBMCP_DETECTOR_VERSION,
    totalControls: WEBMCP_CONTROL_IDS.length,
    assessedCount: Object.values(controls).filter((c) => c.assessed).length,
    notAssessedCount: allStates.filter((s) => s === "NOT_ASSESSED").length,
    detectedCount: allStates.filter((s) => s === "DETECTED").length,
    noFindingCount: allStates.filter((s) => s === "NO_FINDING").length,
    inconclusiveCount: allStates.filter((s) => s === "INCONCLUSIVE").length,
    controls,
    limitsReached: [...new Set(limits)],
    unsupportedFiles: [],
    truncatedFiles: [],
  }
}
