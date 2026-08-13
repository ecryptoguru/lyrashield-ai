import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_03_RULE_ID = "AI-03.supply-chain" as const

const AI_ML_PACKAGES = new Set([
  "openai",
  "anthropic",
  "langchain",
  "@langchain/core",
  "llama-index",
  "transformers",
  "tensorflow",
  "torch",
  "sentence-transformers",
  "chromadb",
  "pinecone-client",
  "@pinecone-database/pinecone",
  "pgvector",
])

const UNBOUNDED_RANGE_PATTERN = /(?:latest|\*|>=\s*["']?\d)/i

function parsePackageJson(
  content: string
): Array<{ name: string; range: string; line: number }> | null {
  try {
    const json = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...json.dependencies, ...json.devDependencies }
    const lines = content.split("\n")
    const result: Array<{ name: string; range: string; line: number }> = []

    for (const [name, range] of Object.entries(deps)) {
      if (!AI_ML_PACKAGES.has(name)) continue
      const lineIndex = lines.findIndex((line) => line.includes(`"${name}"`))
      result.push({ name, range: String(range), line: lineIndex + 1 })
    }

    return result
  } catch {
    return null
  }
}

function isPinnedPnpmLock(content: string): boolean {
  return content.includes("lockfileVersion:") && /version:\s*\d+\.\d+\.\d+/.test(content)
}

export function detectSupplyChain(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-03", AI_03_RULE_ID, file, "Unsupported manifest or truncated file"),
    ]
  }

  if (file.extension === ".json" && file.path.endsWith("package.json")) {
    const deps = parsePackageJson(file.content)
    if (deps === null) {
      return [inconclusiveSignal("AI-03", AI_03_RULE_ID, file, "Failed to parse package.json")]
    }
    if (deps.length === 0) {
      return [noFindingSignal("AI-03", AI_03_RULE_ID, file)]
    }

    for (const dep of deps) {
      if (UNBOUNDED_RANGE_PATTERN.test(dep.range)) {
        const lines = file.content.split("\n")
        const lineText = lines[dep.line - 1] ?? ""
        const start =
          file.content
            .split("\n")
            .slice(0, dep.line - 1)
            .join("\n").length + (dep.line > 1 ? 1 : 0)
        return [
          detectedSignal("AI-03", AI_03_RULE_ID, file, {
            start,
            end: start + lineText.length,
            severity: "MEDIUM",
            remediation: `Pin ${dep.name} to a specific version and verify it against current advisories.`,
          }),
        ]
      }
    }

    return [noFindingSignal("AI-03", AI_03_RULE_ID, file)]
  }

  if (file.extension === ".yaml" || file.extension === ".yml") {
    if (isPinnedPnpmLock(file.content)) {
      const hasAiPackage = [...AI_ML_PACKAGES].some((name) => file.content.includes(name))
      if (hasAiPackage) {
        return [noFindingSignal("AI-03", AI_03_RULE_ID, file)]
      }
    }
    return [inconclusiveSignal("AI-03", AI_03_RULE_ID, file, "Unrecognized YAML manifest")]
  }

  return [noFindingSignal("AI-03", AI_03_RULE_ID, file)]
}
