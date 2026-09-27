import { parsePlanIntent } from "./plan-intent"

const ATTRIBUTION_PROPS = [
  "source",
  "cta",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "landing_route",
  "target_type",
] as const

export const EVENT_ALLOWLIST = {
  landing_view: ["utm_source", "utm_medium", "utm_campaign", "referrer_host"],
  signup_page_viewed: [...ATTRIBUTION_PROPS],
  signup_started: ["method", ...ATTRIBUTION_PROPS],
  account_created: ["method", ...ATTRIBUTION_PROPS],
  github_connect_started: [],
  onboarding_path_chosen: ["path"],
  onboarding_context: ["tool"],
  repos_loaded: ["repo_count_bucket", "load_ms_bucket"],
  repos_selected: ["selected_count"],
  first_run_started: ["preset", "asset_count", "estimate_low_min", "estimate_high_min"],
  trial_started: ["surface"],
  results_viewed: ["status", "had_findings"],
  review_completed: ["status"],
  report_created: ["report_kind"],
  billing_opened: ["plan", "trial_active"],
  upgrade_clicked: ["plan", "interval"],
  checkout_started: ["plan", "interval"],
  checkout_returned: ["provider", "outcome"],
  share_created: ["variant", "channel"],
  notification_opened: ["event_type"],
} as const

type EventName = keyof typeof EVENT_ALLOWLIST
const pendingEvents: Array<[EventName, Record<string, unknown>]> = []
const MAX_PENDING_EVENTS = 20
export const ANALYTICS_PREFERENCE_COOKIE = "lyrashield-analytics"
export const ANALYTICS_PREFERENCE_EVENT = "lyrashield:analytics-preference"
const ANALYTICS_PREFERENCE_MAX_AGE = 180 * 24 * 60 * 60
const SHARED_COOKIE_HOSTS = new Set([
  "lyrashieldai.com",
  "www.lyrashieldai.com",
  "app.lyrashieldai.com",
])
const OPTIONAL_TRACKING_COOKIES = [
  "lyrashield-acq",
  "ls_ref",
  "ls_ref_source",
  "ls_scorecard_visitor",
]
let analyticsPreference: boolean | null = null
let analyticsPreferenceRequest: Promise<boolean | null> | null = null

const LANDING_ROUTES = new Set([
  "home",
  "scan",
  "pricing",
  "agents",
  "tools",
  "compare",
  "blog",
  "docs",
  "about",
  "webmcp",
  "ai-safety",
  "evidence-vault",
  "methodology",
  "research",
  "vibe-security-50",
])
const TARGET_TYPE_HINTS = new Set(["url", "api"])

function sharedCookieDomain(hostname: string): string {
  return SHARED_COOKIE_HOSTS.has(hostname.toLowerCase()) ? "; Domain=.lyrashieldai.com" : ""
}

export interface SignupAttribution {
  source?: string
  cta?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  /** Bounded route token (e.g. "scan", "pricing") — never a raw URL. */
  landingRoute?: string
  /** Preselect hint for onboarding's target chooser. */
  targetTypeHint?: "url" | "api"
}

export function readSignupAttribution(search: string): SignupAttribution {
  const params = new URLSearchParams(search)
  const clean = (value: string | null) =>
    value && /^[a-z0-9_-]{1,64}$/i.test(value) ? value.toLowerCase() : undefined
  const from = clean(params.get("from"))
  const target = clean(params.get("target"))
  return {
    source: clean(params.get("source")),
    cta: clean(params.get("cta")),
    utmSource: clean(params.get("utm_source")),
    utmMedium: clean(params.get("utm_medium")),
    utmCampaign: clean(params.get("utm_campaign")),
    utmContent: clean(params.get("utm_content")),
    landingRoute: from && LANDING_ROUTES.has(from) ? from : undefined,
    targetTypeHint: target && TARGET_TYPE_HINTS.has(target) ? (target as "url" | "api") : undefined,
  }
}

export function signupErrorUrl(attribution: SignupAttribution, selectedPlan?: unknown): string {
  const params = new URLSearchParams()
  if (attribution.source) params.set("source", attribution.source)
  if (attribution.cta) params.set("cta", attribution.cta)
  if (attribution.utmSource) params.set("utm_source", attribution.utmSource)
  if (attribution.utmMedium) params.set("utm_medium", attribution.utmMedium)
  if (attribution.utmCampaign) params.set("utm_campaign", attribution.utmCampaign)
  if (attribution.utmContent) params.set("utm_content", attribution.utmContent)
  if (attribution.landingRoute) params.set("from", attribution.landingRoute)
  if (attribution.targetTypeHint) params.set("target", attribution.targetTypeHint)
  const plan = parsePlanIntent(selectedPlan)
  if (plan) params.set("plan", plan)
  const query = params.toString()
  return `/sign-up${query ? `?${query}` : ""}`
}

/** Snake-cased event props from a parsed attribution snapshot. */
export function attributionProps(a: SignupAttribution): Record<string, unknown> {
  return {
    source: a.source,
    cta: a.cta,
    utm_source: a.utmSource,
    utm_medium: a.utmMedium,
    utm_campaign: a.utmCampaign,
    utm_content: a.utmContent,
    landing_route: a.landingRoute,
    target_type: a.targetTypeHint,
  }
}

/** First-touch acquisition cookie. Consumed once by the onboarding claim. */
export const ACQUISITION_COOKIE = "lyrashield-acq"
const ACQUISITION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60

export function analyticsOptedOut(
  dnt: string | null | undefined,
  gpc: boolean | undefined
): boolean {
  return gpc === true || ["1", "yes"].includes(dnt?.toLowerCase() ?? "")
}

export function analyticsCookiePreference(cookie: string): "on" | "off" | null {
  const match = cookie.match(/(?:^|;\s*)lyrashield-analytics=(on|off)(?:;|$)/)
  return match?.[1] === "on" || match?.[1] === "off" ? match[1] : null
}

function browserPrivacySignalIsOff(): boolean {
  return (
    typeof navigator !== "undefined" &&
    analyticsOptedOut(
      navigator.doNotTrack,
      (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
    )
  )
}

export function analyticsPermissionAllowsOptionalCollection(): boolean {
  if (browserPrivacySignalIsOff() || analyticsPreference !== true) return false
  if (typeof document !== "undefined" && analyticsCookiePreference(document.cookie) === "off") {
    return false
  }
  return true
}

export function analyticsCollectionAllowed(): boolean {
  return (
    Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY) && analyticsPermissionAllowsOptionalCollection()
  )
}

function notifyAnalyticsPreferenceChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent(ANALYTICS_PREFERENCE_EVENT, { detail: analyticsPreference })
    )
  }
}

export function setAnalyticsPreference(enabled: boolean | null): void {
  analyticsPreference = enabled
  if (enabled === false) flushQueuedAnalytics()
  notifyAnalyticsPreferenceChange()
}

export function writeAnalyticsPreferenceCookie(enabled: boolean): void {
  if (typeof document === "undefined" || typeof window === "undefined") return
  const sharedDomain = sharedCookieDomain(window.location.hostname)
  document.cookie = `${ANALYTICS_PREFERENCE_COOKIE}=${enabled ? "on" : "off"}; Path=/; Max-Age=${ANALYTICS_PREFERENCE_MAX_AGE}; SameSite=Lax${sharedDomain}${window.location.protocol === "https:" ? "; Secure" : ""}`
}

export function clearAcquisitionCookie(): void {
  clearOptionalTrackingCookiesInBrowser()
}

export function clearOptionalTrackingCookiesInBrowser(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  const sharedDomain = sharedCookieDomain(window.location.hostname)
  for (const name of OPTIONAL_TRACKING_COOKIES) {
    // HttpOnly referral/visitor cookies are also expired by the preference API.
    // The browser-side expiration covers accessible pending acquisition cookies immediately.
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
    if (sharedDomain) {
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${sharedDomain}${secure}`
    }
  }
}

/** Resolve the account preference before any optional browser capture is allowed. */
export function resolveAnalyticsPreference(): Promise<boolean | null> {
  if (analyticsPreferenceRequest) return analyticsPreferenceRequest
  if (browserPrivacySignalIsOff()) {
    setAnalyticsPreference(false)
    return Promise.resolve(false)
  }
  if (typeof document !== "undefined" && analyticsCookiePreference(document.cookie) === "off") {
    setAnalyticsPreference(false)
    return Promise.resolve(false)
  }
  if (typeof window === "undefined") return Promise.resolve(null)

  analyticsPreferenceRequest = fetch("/api/account/preferences", { cache: "no-store" })
    .then(async (response) => {
      if (response.status === 401) return true // anonymous browser: default enabled
      if (!response.ok) return null
      const body: unknown = await response.json()
      if (!body || typeof body !== "object" || !("success" in body) || body.success !== true) {
        return null
      }
      const data = "data" in body ? body.data : null
      if (!data || typeof data !== "object" || !("analyticsEnabled" in data)) return null
      return typeof data.analyticsEnabled === "boolean" ? data.analyticsEnabled : null
    })
    .catch(() => null)
    .then((enabled) => {
      setAnalyticsPreference(enabled)
      return enabled
    })
    .finally(() => {
      analyticsPreferenceRequest = null
    })
  return analyticsPreferenceRequest
}

/**
 * Serialize acquisition context for the durable-claim cookie. Returns null
 * when there is nothing worth persisting — no empty rows downstream.
 */
export function acquisitionCookieValue(attribution: SignupAttribution): string | null {
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(attribution)) {
    if (value) record[key] = value
  }
  return Object.keys(record).length > 0 ? JSON.stringify(record) : null
}

/** Client-side: persist the bounded attribution snapshot until signup completes. */
export function rememberAcquisition(attribution: SignupAttribution): void {
  if (typeof document === "undefined" || !analyticsPermissionAllowsOptionalCollection()) return
  const value = acquisitionCookieValue(attribution)
  if (!value) return
  const existing = document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${ACQUISITION_COOKIE}=`))
    ?.slice(ACQUISITION_COOKIE.length + 1)
  if (parseAcquisitionCookie(existing)) return
  const sharedDomain = sharedCookieDomain(window.location.hostname)
  document.cookie = `${ACQUISITION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${ACQUISITION_COOKIE_MAX_AGE}; SameSite=Lax${sharedDomain}${window.location.protocol === "https:" ? "; Secure" : ""}`
}

/** Server-side: decode a claim cookie. Returns null on any malformed input. */
export function parseAcquisitionCookie(raw: string | undefined | null): SignupAttribution | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw))
    if (!parsed || typeof parsed !== "object") return null
    const record = parsed as Record<string, unknown>
    const clean = (value: unknown) =>
      typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value)
        ? value.toLowerCase()
        : undefined
    const landingRoute = clean(record.landingRoute)
    const targetTypeHint = clean(record.targetTypeHint)
    return {
      source: clean(record.source),
      cta: clean(record.cta),
      utmSource: clean(record.utmSource),
      utmMedium: clean(record.utmMedium),
      utmCampaign: clean(record.utmCampaign),
      utmContent: clean(record.utmContent),
      landingRoute: landingRoute && LANDING_ROUTES.has(landingRoute) ? landingRoute : undefined,
      targetTypeHint:
        targetTypeHint && TARGET_TYPE_HINTS.has(targetTypeHint)
          ? (targetTypeHint as "url" | "api")
          : undefined,
    }
  } catch {
    return null
  }
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
  if (typeof window === "undefined" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return
  if (!analyticsPermissionAllowsOptionalCollection()) {
    flushQueuedAnalytics()
    return
  }

  const sanitized = sanitizeProperties(event, properties) ?? {}
  const posthog = (
    window as unknown as {
      posthog?: { capture?: (name: EventName, props: Record<string, unknown>) => void }
    }
  ).posthog
  if (posthog?.capture) {
    posthog.capture(event, sanitized)
  } else if (pendingEvents.length < MAX_PENDING_EVENTS) {
    pendingEvents.push([event, sanitized])
  }
}

export function flushQueuedAnalytics(
  capture?: (event: EventName, properties: Record<string, unknown>) => void
): void {
  if (!analyticsPermissionAllowsOptionalCollection()) {
    pendingEvents.length = 0
    return
  }
  const events = pendingEvents.splice(0)
  if (capture) for (const [event, properties] of events) capture(event, properties)
}
