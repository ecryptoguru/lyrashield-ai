import type { AIControlId, AIScanFile, AISecuritySignal } from "../types"
import { detectPromptInjection } from "./prompt-injection"
import { detectSensitiveContext } from "./sensitive-context"
import { detectSupplyChain } from "./supply-chain"
import { detectOutputHandling } from "./output-handling"
import { detectExcessiveAgency } from "./excessive-agency"
import { detectSystemPrompt } from "./system-prompt"
import { detectVectorAccess } from "./vector-access"
import { detectConsumptionLimits } from "./consumption-limits"

export * from "./prompt-injection"
export * from "./sensitive-context"
export * from "./supply-chain"
export * from "./output-handling"
export * from "./excessive-agency"
export * from "./system-prompt"
export * from "./vector-access"
export * from "./consumption-limits"

export type AIRule = {
  id: string
  controlId: AIControlId
  fn: (file: AIScanFile) => AISecuritySignal[]
}

export const AI_RULES: AIRule[] = [
  { id: "AI-01.prompt-injection", controlId: "AI-01", fn: detectPromptInjection },
  { id: "AI-02.sensitive-context", controlId: "AI-02", fn: detectSensitiveContext },
  { id: "AI-03.supply-chain", controlId: "AI-03", fn: detectSupplyChain },
  { id: "AI-04.output-handling", controlId: "AI-04", fn: detectOutputHandling },
  { id: "AI-05.excessive-agency", controlId: "AI-05", fn: detectExcessiveAgency },
  { id: "AI-06.system-prompt", controlId: "AI-06", fn: detectSystemPrompt },
  { id: "AI-07.vector-access", controlId: "AI-07", fn: detectVectorAccess },
  { id: "AI-08.consumption-limits", controlId: "AI-08", fn: detectConsumptionLimits },
]
