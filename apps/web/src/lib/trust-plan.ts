// Type definitions for a product's trust plan.
// Stored in `Project.trustPlan` (nullable JSONB) and surfaced in the Trust Command Center.

export interface TrustPlanControl {
  id: string
  enabled: boolean
  priority?: "required" | "recommended" | "optional"
  note?: string
}

export interface TrustPlan {
  preset: "launch" | "continuous" | "compliance" | "custom"
  controls: TrustPlanControl[]
  schedule: "manual" | "daily" | "weekly"
  createdAt: string
  updatedAt: string
}

export const TRUST_PLAN_PRESETS: { value: TrustPlan["preset"]; label: string; description: string }[] = [
  { value: "launch", label: "Launch readiness", description: "Evidence before release." },
  { value: "continuous", label: "Continuous review", description: "Ongoing checks on every significant change." },
  { value: "compliance", label: "Compliance baseline", description: "Documented controls and audit trail." },
  { value: "custom", label: "Custom", description: "Choose your own controls and schedule." },
]

export function emptyTrustPlan(): TrustPlan {
  return {
    preset: "launch",
    controls: [],
    schedule: "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
