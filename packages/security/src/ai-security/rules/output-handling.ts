import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_04_RULE_ID = "AI-04.output-handling" as const

const LLM_OUTPUT_ASSIGNMENT = /(?:const|let|var)\s+(\w+)\s*=\s*/

function hasVariableNear(line: string, variable: string, keyword: string): boolean {
  const lower = line.toLowerCase()
  const varIndex = line.indexOf(variable)
  if (varIndex === -1) return false
  const keyIndex = lower.indexOf(keyword.toLowerCase())
  return keyIndex !== -1 && Math.abs(varIndex - keyIndex) < 120
}

function isDangerousUse(line: string, variable: string): boolean {
  const lower = line.toLowerCase()

  const evalCall = "eval" + "("
  if (lower.includes(evalCall) && hasVariableNear(line, variable, evalCall)) return true
  if (lower.includes("new function(") && hasVariableNear(line, variable, "new function("))
    // security-scan-ok: matches new Function() in scanned source, not executed
    return true
  if (
    (lower.includes(".exec(") || lower.includes("child_process.exec")) &&
    hasVariableNear(line, variable, "exec")
  )
    return true
  if (lower.includes(".query(") || lower.includes("query(")) {
    if (line.includes(`\${${variable}}`)) return true
  }
  if (lower.includes(".execute(") || lower.includes("execute(")) {
    if (line.includes(`\${${variable}}`)) return true
  }
  if (lower.includes(".innerhtml") && hasVariableNear(line, variable, ".innerhtml")) return true
  if (
    lower.includes("dangerouslysetinnerhtml") &&
    hasVariableNear(line, variable, "dangerouslysetinnerhtml")
  )
    return true
  if (lower.includes("v-html") && hasVariableNear(line, variable, "v-html")) return true
  if (
    (lower.includes("writefile(") || lower.includes("writefilesync(")) &&
    hasVariableNear(line, variable, "writefile")
  )
    return true
  if (
    (lower.includes("fetch(") ||
      lower.includes("axios.get(") ||
      lower.includes("axios.post(") ||
      lower.includes("axios.request(")) &&
    hasVariableNear(line, variable, "fetch")
  )
    return true

  return false
}

export function detectOutputHandling(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-04", AI_04_RULE_ID, file, "Unsupported language or truncated file"),
    ]
  }

  const lines = file.content.split("\n")
  const lLMOutputVariables: Array<{ name: string; lineIndex: number }> = []

  for (const [index, line] of lines.entries()) {
    LLM_OUTPUT_ASSIGNMENT.lastIndex = 0
    const match = LLM_OUTPUT_ASSIGNMENT.exec(line)
    if (match?.[1] && line.includes(".message.content")) {
      lLMOutputVariables.push({ name: match[1], lineIndex: index })
    }
  }

  if (lLMOutputVariables.length === 0) {
    return [noFindingSignal("AI-04", AI_04_RULE_ID, file)]
  }

  for (const variable of lLMOutputVariables) {
    for (const [index, line] of lines.entries()) {
      if (index === variable.lineIndex) continue
      if (isDangerousUse(line, variable.name)) {
        const start = lines.slice(0, index).join("\n").length + (index > 0 ? 1 : 0)
        return [detectedSignal("AI-04", AI_04_RULE_ID, file, { start, end: start + line.length })]
      }
    }
  }

  return [noFindingSignal("AI-04", AI_04_RULE_ID, file)]
}
