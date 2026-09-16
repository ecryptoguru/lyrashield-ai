/**
 * Guided workflow definitions — deterministic step graphs the agent walks
 * users through. Steps with `check` re-run a read-only tool to advance on
 * observed state (closed loop), never on the user's word. Pure data; the
 * executor lives in server/.
 */
import type { MyraToolName } from "./contracts"

export interface FlowStep {
  id: string
  title: string
  /** User-facing instruction shown while the step is active. */
  instruction: string
  /** Read-only tool re-run to verify the step passed. Absent = manual step. */
  check?: { tool: MyraToolName; expect: string }
  /** Deep link offered while the step is active (must be a manifest route). */
  ctaRoute?: string
}

export interface FlowDefinition {
  id: string
  title: string
  /** Surfaces where the flow can start. */
  surfaces: ("marketing" | "app")[]
  /** Route contexts that suggest this flow. */
  suggestOnRoutes: string[]
  steps: FlowStep[]
}

export const GUIDED_FLOWS: readonly FlowDefinition[] = [
  {
    id: "scan_wont_start",
    title: "Get your scan running",
    surfaces: ["app"],
    suggestOnRoutes: ["/dashboard/scans", "/dashboard/targets", "/dashboard"],
    steps: [
      {
        id: "target_exists",
        title: "A target exists",
        instruction: "Your workspace needs at least one target to scan.",
        check: { tool: "get_my_context", expect: "targetCount > 0" },
        ctaRoute: "/dashboard/targets",
      },
      {
        id: "entitlement_ok",
        title: "Your plan can run the scan",
        instruction: "Check remaining minutes and scan-depth access on your plan.",
        check: { tool: "get_my_context", expect: "canScan == true" },
        ctaRoute: "/dashboard/billing",
      },
      {
        id: "connection_ok",
        title: "The target connection is healthy",
        instruction: "The target's connection (repo or URL reachability) must be active.",
        check: { tool: "get_connection_health", expect: "unhealthy == 0" },
        ctaRoute: "/dashboard/settings",
      },
      {
        id: "verified",
        title: "Scan can start",
        instruction: "Re-checking that the blocker is cleared.",
        check: { tool: "verify_resolution", expect: "scan_can_start" },
        ctaRoute: "/dashboard/scans",
      },
    ],
  },
  {
    id: "understand_result",
    title: "Understand a result",
    surfaces: ["app"],
    suggestOnRoutes: ["/dashboard/findings", "/dashboard/scans"],
    steps: [
      {
        id: "explain_states",
        title: "What the evidence states mean",
        instruction:
          "Detected ≠ verified. I'll pull the scan's status and explain what is and isn't proven.",
        check: { tool: "get_scan_status", expect: "status known" },
        ctaRoute: "/dashboard/findings",
      },
      {
        id: "next_action",
        title: "Pick the next action",
        instruction: "Depending on state: request a retest, review evidence, or escalate.",
        ctaRoute: "/dashboard/findings",
      },
    ],
  },
  {
    id: "trial_help",
    title: "Make the most of your trial",
    surfaces: ["app", "marketing"],
    suggestOnRoutes: ["/dashboard", "/pricing"],
    steps: [
      {
        id: "trial_state",
        title: "Your trial at a glance",
        instruction: "I'll check your remaining trial minutes and days.",
        check: { tool: "get_my_context", expect: "trial state returned" },
        ctaRoute: "/dashboard",
      },
      {
        id: "first_scan",
        title: "Run your first Standard scan",
        instruction: "Add a target and start a Standard scan to see the evidence workflow.",
        ctaRoute: "/dashboard/targets",
      },
    ],
  },
]

export function getFlow(id: string): FlowDefinition | undefined {
  return GUIDED_FLOWS.find((f) => f.id === id)
}

export function suggestFlows(routeContext: string | null | undefined): FlowDefinition[] {
  if (!routeContext) return []
  return GUIDED_FLOWS.filter((f) => f.suggestOnRoutes.includes(routeContext))
}
