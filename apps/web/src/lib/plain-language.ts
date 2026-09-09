import type { FindingSeverity } from "@lyrashield/db"
// Shared CWE catalogue and severity fallbacks live in @lyrashield/types so the
// worker engine explains findings identically (the duplicate copy drifted once).
import { CWE_EXPLANATIONS, GENERIC_EXPLANATIONS } from "@lyrashield/types"
import type { PlainLanguageFinding } from "@lyrashield/types"

export type { PlainLanguageFinding }

const CATEGORY_LABELS: Record<string, string> = {
  injection: "Injection Vulnerability",
  xss: "Cross-Site Scripting",
  csrf: "Cross-Site Request Forgery",
  ssrf: "Server-Side Request Forgery",
  auth: "Authentication Issue",
  crypto: "Cryptographic Weakness",
  config: "Security Misconfiguration",
  disclosure: "Information Disclosure",
  access_control: "Access Control Issue",
  deserialization: "Deserialization Issue",
  dependencies: "Vulnerable Dependency",
  secrets: "Exposed Secret",
}

export function explainFinding(params: {
  title: string
  severity: FindingSeverity
  cwe?: string | null
  category?: string | null
  recommendedFix?: string | null
}): PlainLanguageFinding {
  if (params.cwe && CWE_EXPLANATIONS[params.cwe]) {
    const explanation = CWE_EXPLANATIONS[params.cwe]!
    if (params.recommendedFix) {
      return { ...explanation, howToFix: params.recommendedFix }
    }
    return { ...explanation }
  }

  const generic = GENERIC_EXPLANATIONS[params.severity]!
  const categoryLabel = params.category ? CATEGORY_LABELS[params.category] : null
  const title = categoryLabel ?? params.title
  if (params.recommendedFix) {
    return { ...generic, title, howToFix: params.recommendedFix }
  }
  return { ...generic, title }
}
