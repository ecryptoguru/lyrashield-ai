import type { FindingSeverity } from "@lyrashield/types"
// Shared CWE catalogue and severity fallbacks live in @lyrashield/types so the
// web API and the worker explain findings identically (the duplicate copy
// drifted once). This app keeps its own wrapper because it appends the raw
// technical detail the web API strips out.
import { CWE_EXPLANATIONS, GENERIC_EXPLANATIONS } from "@lyrashield/types"
import type { PlainLanguageFinding } from "@lyrashield/types"

export type { PlainLanguageFinding }

export function explainFinding(params: {
  title: string
  severity: FindingSeverity
  cwe?: string | null
  category?: string | null
  technicalDetail?: string | null
  recommendedFix?: string | null
}): PlainLanguageFinding {
  if (params.cwe && CWE_EXPLANATIONS[params.cwe]) {
    const explanation = CWE_EXPLANATIONS[params.cwe]!
    const whatItIs = params.technicalDetail
      ? `${explanation.whatItIs}\n\nTechnical detail: ${params.technicalDetail}`
      : explanation.whatItIs
    if (params.recommendedFix) {
      return { ...explanation, whatItIs, howToFix: params.recommendedFix }
    }
    return { ...explanation, whatItIs }
  }

  const generic = GENERIC_EXPLANATIONS[params.severity]!
  const whatItIs = params.technicalDetail
    ? `${generic.whatItIs}\n\nTechnical detail: ${params.technicalDetail}`
    : generic.whatItIs
  if (params.recommendedFix) {
    return { ...generic, title: params.title, whatItIs, howToFix: params.recommendedFix }
  }
  return { ...generic, title: params.title, whatItIs }
}
