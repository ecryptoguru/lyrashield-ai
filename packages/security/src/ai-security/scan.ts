import { AI_SECURITY_CONTROLS } from "./controls"
import { AI_RULES } from "./rules"
import { buildProvenance, buildSignal, inconclusiveSignal, isSupportedFile } from "./utils"
import type {
  AIControlId,
  AIScanFile,
  AIScanLimit,
  AIScanLimits,
  AIScanResult,
  AIControlCoverage,
  AISecurityCoverage,
  AISecurityProvenance,
  AISecuritySignal,
  AISecuritySignalState,
} from "./types"

export type AIScanOptions = {
  limits: AIScanLimits
  includeControls?: AIControlId[]
}

function applyFileLimits(
  files: AIScanFile[],
  limits: AIScanLimits
): {
  selected: AIScanFile[]
  limitsReached: AIScanLimit[]
  unsupportedFiles: string[]
  truncatedFiles: string[]
} {
  const limitsReached: AIScanLimit[] = []
  const unsupportedFiles: string[] = []
  const truncatedFiles: string[] = []

  if (files.length > limits.maxFiles) {
    limitsReached.push("max_files")
  }

  let totalBytes = 0
  const selected: AIScanFile[] = []

  for (const file of files) {
    if (selected.length >= limits.maxFiles) break

    if (file.size > limits.maxFileBytes) {
      limitsReached.push("max_file_bytes")
      truncatedFiles.push(file.path)
      continue
    }

    if (totalBytes + file.size > limits.maxTotalBytes) {
      limitsReached.push("max_total_bytes")
      truncatedFiles.push(file.path)
      continue
    }

    if (limits.allowedExtensions && !limits.allowedExtensions.includes(file.extension)) {
      unsupportedFiles.push(file.path)
      continue
    }

    totalBytes += file.size
    selected.push(file)
  }

  return { selected, limitsReached: [...new Set(limitsReached)], unsupportedFiles, truncatedFiles }
}

export function scanAiSecurityFiles(files: AIScanFile[], options: AIScanOptions): AIScanResult {
  const start = Date.now()
  const { selected, limitsReached, unsupportedFiles, truncatedFiles } = applyFileLimits(
    files,
    options.limits
  )

  const activeControls = new Set(options.includeControls ?? AI_SECURITY_CONTROLS.map((c) => c.id))
  const activeRules = AI_RULES.filter((rule) => activeControls.has(rule.controlId))

  const signals: AISecuritySignal[] = []
  const byControl = new Map<AIControlId, AISecuritySignal[]>()

  for (const file of selected) {
    for (const rule of activeRules) {
      if (Date.now() - start > options.limits.maxWallTimeMs) {
        limitsReached.push("max_wall_time_ms")
        break
      }

      if (!isSupportedFile(file)) {
        const signal = inconclusiveSignal(
          rule.controlId,
          rule.id,
          file,
          "Unsupported language or truncated file"
        )
        signals.push(signal)
        appendSignal(byControl, rule.controlId, signal)
        continue
      }

      try {
        const ruleSignals = rule.fn(file)
        for (const signal of ruleSignals) {
          signals.push(signal)
          appendSignal(byControl, signal.controlId, signal)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const signal = inconclusiveSignal(rule.controlId, rule.id, file, message)
        signals.push(signal)
        appendSignal(byControl, rule.controlId, signal)
      }
    }
  }

  for (const control of AI_SECURITY_CONTROLS) {
    const rule = AI_RULES.find((r) => r.controlId === control.id)
    if (!rule) continue

    if (!activeControls.has(control.id)) {
      const placeholderFile: AIScanFile = {
        path: "<not-assessed>",
        content: "",
        size: 0,
        extension: "",
        language: "unknown",
      }
      const signal = buildSignal(control.id, rule.id, "NOT_ASSESSED", placeholderFile, {
        overrideRemediation: "Control is not assessed in this scan profile.",
      })
      signals.push(signal)
      appendSignal(byControl, control.id, signal)
      continue
    }

    if (!byControl.has(control.id)) {
      const placeholderFile: AIScanFile = {
        path: "<not-assessed>",
        content: "",
        size: 0,
        extension: "",
        language: "unknown",
      }
      const signal = buildSignal(control.id, rule.id, "NOT_ASSESSED", placeholderFile, {
        overrideRemediation: "No supported files available to assess this control.",
      })
      signals.push(signal)
      appendSignal(byControl, control.id, signal)
    }
  }

  const provenance: AISecurityProvenance = {
    ...buildProvenance(selected, limitsReached, start),
    detectorVersion: signals[0]?.detectorVersion ?? "ai-app-security/unknown",
    limitsReached,
  }

  const coverage = summarizeAiSecurityCoverage(
    signals,
    AI_SECURITY_CONTROLS.map((c) => c.id),
    {
      limitsReached,
      unsupportedFiles,
      truncatedFiles,
    }
  )

  return { signals, coverage, provenance }
}

function appendSignal(
  map: Map<AIControlId, AISecuritySignal[]>,
  controlId: AIControlId,
  signal: AISecuritySignal
): void {
  const existing = map.get(controlId)
  if (existing) {
    existing.push(signal)
  } else {
    map.set(controlId, [signal])
  }
}

export function summarizeAiSecurityCoverage(
  signals: AISecuritySignal[],
  allControlIds: AIControlId[],
  extra: {
    limitsReached: AIScanLimit[]
    unsupportedFiles: string[]
    truncatedFiles: string[]
  }
): AISecurityCoverage {
  const byControl = new Map<AIControlId, AISecuritySignal[]>()
  for (const signal of signals) {
    appendSignal(byControl, signal.controlId, signal)
  }

  const controls: Record<AIControlId, AIControlCoverage> = {} as Record<
    AIControlId,
    AIControlCoverage
  >
  let assessedCount = 0
  let notAssessedCount = 0
  let detectedCount = 0
  let noFindingCount = 0
  let inconclusiveCount = 0

  for (const controlId of allControlIds) {
    const controlSignals = byControl.get(controlId) ?? []
    const fileCount = new Set(controlSignals.map((s) => s.file)).size
    const state = reduceControlState(controlSignals.map((s) => s.state))
    const evidenceSource = controlSignals.find((s) => s.evidenceSource)?.evidenceSource

    const coverage: AIControlCoverage = {
      controlId,
      state,
      assessed: state !== "NOT_ASSESSED",
      evidenceSource,
      ruleIds: [...new Set(controlSignals.map((s) => s.ruleId))],
      fileCount,
      signalCount: controlSignals.length,
    }

    controls[controlId] = coverage

    if (state !== "NOT_ASSESSED") assessedCount++
    if (state === "NOT_ASSESSED") notAssessedCount++
    if (state === "DETECTED") detectedCount++
    if (state === "NO_FINDING") noFindingCount++
    if (state === "INCONCLUSIVE") inconclusiveCount++
  }

  return {
    version: signals[0]?.detectorVersion ?? "ai-app-security/unknown",
    totalControls: allControlIds.length,
    assessedCount,
    notAssessedCount,
    detectedCount,
    noFindingCount,
    inconclusiveCount,
    controls,
    limitsReached: extra.limitsReached,
    unsupportedFiles: extra.unsupportedFiles,
    truncatedFiles: extra.truncatedFiles,
  }
}

function reduceControlState(states: AISecuritySignalState[]): AISecuritySignalState {
  if (states.length === 0) return "NOT_ASSESSED"
  if (states.includes("DETECTED")) return "DETECTED"
  if (states.includes("INCONCLUSIVE")) return "INCONCLUSIVE"
  if (states.every((s) => s === "NO_FINDING")) return "NO_FINDING"
  if (states.includes("NOT_ASSESSED")) return "NOT_ASSESSED"
  return "INCONCLUSIVE"
}
