export const FRAMEWORK_MAPPING_VERSION = "ai-assurance-mapping/1.0.0" as const

export type FrameworkId = "OWASP_LLM"
export type FrameworkReadiness =
  "OBSERVED" | "EVIDENCE_ACCEPTED" | "NOT_ASSESSED" | "NOT_APPLICABLE"

export type FrameworkMapping = {
  framework: FrameworkId
  frameworkId: string
  controlId: string
  mappingVersion: typeof FRAMEWORK_MAPPING_VERSION
  rationale: string
}

const OWASP_MAPPING_INPUTS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "AI-01",
    "LLM01:2025",
    "Prompt input handling is directly assessed by the bounded deterministic rule.",
  ],
  [
    "AI-02",
    "LLM02:2025",
    "Sensitive context handling is directly assessed by the bounded deterministic rule.",
  ],
  [
    "AI-03",
    "LLM03:2025",
    "Resolved AI/ML dependency advisory coverage is assessed separately and fails closed.",
  ],
  [
    "AI-04",
    "LLM05:2025",
    "Dangerous LLM output sinks are directly assessed by the bounded deterministic rule.",
  ],
  [
    "AI-05",
    "LLM06:2025",
    "Agent approval and destructive-tool settings are directly assessed by the bounded deterministic rule.",
  ],
  [
    "AI-06",
    "LLM07:2025",
    "Client-exposed system-prompt patterns are directly assessed by the bounded deterministic rule.",
  ],
  [
    "AI-07",
    "LLM08:2025",
    "Vector retrieval scope is directly assessed by the bounded deterministic rule.",
  ],
  [
    "AI-08",
    "LLM10:2025",
    "Consumption limits are directly assessed by the bounded deterministic rule.",
  ],
  ["vibe-43", "LLM06:2025", "Sandbox and egress controls require accepted operational evidence."],
]

export const FRAMEWORK_MAPPINGS: readonly FrameworkMapping[] = OWASP_MAPPING_INPUTS.map(
  ([controlId, frameworkId, rationale]) => ({
    framework: "OWASP_LLM" as const,
    frameworkId,
    controlId,
    mappingVersion: FRAMEWORK_MAPPING_VERSION,
    rationale,
  })
)

export type FrameworkAssessment = {
  version: typeof FRAMEWORK_MAPPING_VERSION
  items: Array<FrameworkMapping & { status: FrameworkReadiness }>
}

export function evaluateFrameworkReadiness(
  states: Record<string, string | undefined>
): FrameworkAssessment {
  return {
    version: FRAMEWORK_MAPPING_VERSION,
    items: FRAMEWORK_MAPPINGS.map((item) => {
      const state = states[item.controlId]
      const status: FrameworkReadiness =
        state === "DETECTED"
          ? "OBSERVED"
          : state === "EVIDENCE_ACCEPTED"
            ? "EVIDENCE_ACCEPTED"
            : state === "NOT_APPLICABLE"
              ? "NOT_APPLICABLE"
              : "NOT_ASSESSED"
      return { ...item, status }
    }),
  }
}
