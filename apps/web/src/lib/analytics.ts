import { parsePlanIntent } from "./plan-intent"

export const EVENT_ALLOWLIST = {
  landing_view: ["utm_source", "utm_medium", "utm_campaign", "referrer_host"],
  signup_page_viewed: ["source", "cta"],
  signup_started: ["method", "source", "cta"],
  account_created: ["method", "source", "cta"],
  github_connect_started: [],
  github_connected: ["repo_count_bucket", "account_type"],
  onboarding_path_chosen: ["path"],
  repos_loaded: ["repo_count_bucket", "load_ms_bucket"],
  repos_selected: ["selected_count"],
  product_confirmed: ["asset_count", "suggested_assets_declined"],
  trust_plan_accepted: ["plan_preset", "customised"],
  first_run_started: ["preset", "asset_count", "estimate_low_min", "estimate_high_min"],
  first_run_completed: ["preset", "duration_bucket", "verdict", "outcome"],
  first_issue_viewed: ["verification_status"],
  first_remediation_action: ["action_type"],
  first_retest: ["outcome"],
  first_evidence_share: ["variant", "channel"],
  run_started: [],
  run_completed: [],
  approval_requested: [],
  approval_decided: ["decision"],
  issue_status_changed: ["from_status", "to_status"],
  evidence_refreshed: [],
  share_created: ["variant", "channel"],
  share_revoked: [],
  notification_opened: ["event_type"],
  weekly_return: [],
} as const

export type EventName = keyof typeof EVENT_ALLOWLIST
export type SignupAttribution = { source?: string; cta?: string }

export function readSignupAttribution(search: string): SignupAttribution {
  const params = new URLSearchParams(search)
  const clean = (value: string | null) =>
    value && /^[a-z0-9_-]{1,64}$/i.test(value) ? value.toLowerCase() : undefined
  return { source: clean(params.get("source")), cta: clean(params.get("cta")) }
}

export function signupErrorUrl(attribution: SignupAttribution, selectedPlan?: unknown): string {
  const params = new URLSearchParams()
  if (attribution.source) params.set("source", attribution.source)
  if (attribution.cta) params.set("cta", attribution.cta)
  const plan = parsePlanIntent(selectedPlan)
  if (plan) params.set("plan", plan)
  const query = params.toString()
  return `/sign-up${query ? `?${query}` : ""}`
}

// Property keys that must never reach analytics, regardless of event.
const FORBIDDEN_PROPERTY_KEYS = new Set([
  "repository",
  "repository_name",
  "repo_name",
  "repoName",
  "repoFullName",
  "repo_owner",
  "repoOwner",
  "owner_login",
  "owner_login_name",
  "target_url",
  "targetUrl",
  "url",
  "branch",
  "branch_name",
  "defaultBranch",
  "file_path",
  "filePath",
  "finding_title",
  "findingTitle",
  "title",
  "cwe",
  "cwe_id",
  "severity",
  "issue_count",
  "evidence_content",
  "evidenceContent",
  "caption",
  "caption_text",
  "ip_address",
  "ip",
  "user_agent",
  "userAgent",
  "cost",
  "spend",
  "token_count",
  "token_count_input",
  "token_count_output",
  "input_tokens",
  "output_tokens",
  "cap",
  "cap_value",
])

const MAX_PROPERTY_STRING_LENGTH = 500

export function sanitizeProperties<T extends EventName>(
  event: T,
  properties: Record<string, unknown> = {}
): Record<string, unknown> | null {
  const allowed = new Set<string>(EVENT_ALLOWLIST[event])
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key)) continue
    if (FORBIDDEN_PROPERTY_KEYS.has(key.toLowerCase()) || FORBIDDEN_PROPERTY_KEYS.has(key)) continue
    if (typeof value === "string" && value.length > MAX_PROPERTY_STRING_LENGTH) continue
    if (value === undefined) continue
    sanitized[key] = value
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null
}

export function track<T extends EventName>(event: T, properties?: Record<string, unknown>): void {
  const sanitized = sanitizeProperties(event, properties)

  if (
    typeof window !== "undefined" &&
    typeof (window as unknown as { posthog?: { capture: (...args: unknown[]) => void } }).posthog
      ?.capture === "function"
  ) {
    ;(window as unknown as { posthog: { capture: (...args: unknown[]) => void } }).posthog.capture(
      event,
      sanitized ?? {}
    )
  }
}
