const URL_PROPERTIES = [
  "$current_url",
  "$referrer",
  "$initial_referrer",
  "$session_entry_url",
  "$session_entry_referrer",
  "referrer",
]

// Property keys that must never reach analytics, regardless of event.
// Mirrors FORBIDDEN_PROPERTY_KEYS in apps/web/src/lib/analytics.ts plus the
// target-derived keys the Lite Check used to send.
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
  "target",
  "target_url",
  "targetUrl",
  "target_domain",
  "target_domain_hash",
  "domain_hash",
  "hostname",
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
  "category",
  "categories_flagged",
  "issue_count",
  "evidence_content",
  "evidenceContent",
  "caption",
  "caption_text",
  "email",
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

/**
 * Explicit per-event property allowlist for marketing captures. Anything not
 * named here is dropped before the event reaches PostHog. Mirrors the
 * EVENT_ALLOWLIST approach in apps/web/src/lib/analytics.ts.
 */
export const MARKETING_EVENT_ALLOWLIST = {
  $pageview: ["$current_url"],
  landing_view: ["utm_source", "utm_medium", "utm_campaign", "referrer"],
  cta_click: ["cta_id"],
  faq_open: ["question_id"],
  cinematic_chapter_view: ["chapter_id", "mode"],
  cinematic_media_error: ["chapter_id", "asset_type", "source_kind"],
  scan_started: ["product", "device", "utm_source", "utm_medium", "utm_campaign", "referrer"],
  scan_completed: ["product", "duration_ms", "finding_count", "had_findings"],
  scan_blocked: ["product", "reason"],
  scan_error: ["product", "reason"],
  finding_expanded: ["product"],
  upsell_viewed: ["product"],
  upsell_clicked: ["product", "cta"],
  waitlist_joined: ["product", "source"],
  referral_visit: ["product", "source"],
  referral_signup: ["product", "source"],
  scorecard_generated: ["product", "referral_code"],
  scorecard_shared: ["product", "channel"],
  waitlist_form_start: [],
  waitlist_submit_error: ["error_type"],
  waitlist_submit_success: ["role"],
  waitlist_referral_share: ["channel"],
} as const

export type MarketingEventName = keyof typeof MARKETING_EVENT_ALLOWLIST

const MAX_PROPERTY_STRING_LENGTH = 500

/**
 * Returns only the properties allowlisted for `event`, or null when nothing
 * survives. Forbidden keys are stripped first so an allowlist mistake can
 * never leak a target-derived or finding-detail value. Unknown event names
 * allowlist nothing and fail closed.
 */
export function sanitizeMarketingProperties(
  event: MarketingEventName,
  properties: Record<string, unknown> = {}
): Record<string, unknown> | null {
  const allowed = new Set<string>(MARKETING_EVENT_ALLOWLIST[event] ?? [])
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN_PROPERTY_KEYS.has(key) || FORBIDDEN_PROPERTY_KEYS.has(key.toLowerCase())) continue
    if (!allowed.has(key)) continue
    if (typeof value === "string" && value.length > MAX_PROPERTY_STRING_LENGTH) continue
    if (value === undefined) continue
    sanitized[key] = value
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null
}

export function privacyBoundedMarketingEvent<T extends { properties: Record<string, unknown> }>(
  event: T
): T {
  for (const key of Object.keys(event.properties)) {
    if (FORBIDDEN_PROPERTY_KEYS.has(key) || FORBIDDEN_PROPERTY_KEYS.has(key.toLowerCase())) {
      delete event.properties[key]
    }
  }
  for (const property of URL_PROPERTIES) {
    const value = event.properties[property]
    if (typeof value !== "string") continue
    try {
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        delete event.properties[property]
        continue
      }
      event.properties[property] = `${url.origin}${url.pathname}`
    } catch {
      delete event.properties[property]
    }
  }
  return event
}
