import {
  detectedSignal,
  extractCallBlock,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_07_RULE_ID = "AI-07.vector-access" as const

const VECTOR_CLIENT_PATTERNS = [
  /new\s+Pinecone\s*\(/i,
  /new\s+ChromaClient\s*\(/i,
  /new\s+WeaviateClient\s*\(/i,
  /new\s+OpenAIEmbeddings\s*\(/i,
  /\.fromExistingIndex\s*\(/i,
]

const VECTOR_QUERY_PATTERNS = [/\.query\s*\(/i, /similaritySearch\s*\(/i, /\.search\s*\(/i]

const SCOPE_KEYWORDS = ["filter:", "where:", "namespace", "tenant", "workspaceId", "userId"]

export function detectVectorAccess(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-07", AI_07_RULE_ID, file, "Unsupported language or truncated file"),
    ]
  }

  const hasVectorClient = VECTOR_CLIENT_PATTERNS.some((pattern) => pattern.test(file.content))
  if (!hasVectorClient) {
    return [noFindingSignal("AI-07", AI_07_RULE_ID, file)]
  }

  const lines = file.content.split("\n")
  for (const [index, line] of lines.entries()) {
    const hasQuery = VECTOR_QUERY_PATTERNS.some((pattern) => pattern.test(line))
    if (!hasQuery) continue

    const prior = lines.slice(0, index).join("\n")
    const start = prior.length + (index > 0 ? 1 : 0)
    const callBlock = extractCallBlock(file.content, start).toLowerCase()
    const hasScope = SCOPE_KEYWORDS.some((keyword) => callBlock.includes(keyword.toLowerCase()))

    if (!hasScope) {
      return [detectedSignal("AI-07", AI_07_RULE_ID, file, { start, end: start + line.length })]
    }
  }

  return [noFindingSignal("AI-07", AI_07_RULE_ID, file)]
}
