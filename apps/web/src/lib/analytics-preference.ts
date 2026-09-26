import { getSession } from "@lyrashield/auth/server"
import { withAccountRLS } from "@lyrashield/db"

export const ANALYTICS_PREFERENCE_COOKIE = "lyrashield-analytics"
export const OPTIONAL_TRACKING_COOKIES = [
  "lyrashield-acq",
  "ls_ref",
  "ls_ref_source",
  "ls_scorecard_visitor",
] as const

export interface AnalyticsBrowserSession {
  userId: string
  apiKey?: unknown
  oauth?: unknown
}

export function browserAnalyticsPreferenceIsOff(cookieHeader: string | null): boolean {
  return (
    cookieHeader
      ?.split(";")
      .map((part) => part.trim())
      .some((part) => part === `${ANALYTICS_PREFERENCE_COOKIE}=off`) ?? false
  )
}

export function requestPrivacySignalIsOff(request: Pick<Request, "headers">): boolean {
  const dnt = request.headers.get("dnt")?.toLowerCase()
  return dnt === "1" || dnt === "yes" || request.headers.get("sec-gpc") === "1"
}

/** Unknown account state suppresses optional collection; no workspace is needed. */
export async function analyticsAllowedForRequest(
  request: Pick<Request, "headers">,
  options?: { session?: AnalyticsBrowserSession | null }
): Promise<boolean> {
  if (
    requestPrivacySignalIsOff(request) ||
    browserAnalyticsPreferenceIsOff(request.headers.get("cookie"))
  ) {
    return false
  }

  try {
    const session = options && "session" in options ? options.session : await getSession()
    if (!session) return true
    if (session.apiKey || session.oauth) return false
    const preference = await withAccountRLS(session.userId, (tx) =>
      tx.accountPreference.findUnique({
        where: { accountId: session.userId },
        select: { analyticsEnabled: true },
      })
    )
    return preference?.analyticsEnabled ?? true
  } catch {
    return false
  }
}

export function clearOptionalTrackingCookies(
  response: Response,
  request: Pick<Request, "url">
): void {
  const url = new URL(request.url)
  const secure = url.protocol === "https:"
  const sharedDomainHosts = new Set([
    "lyrashieldai.com",
    "www.lyrashieldai.com",
    "app.lyrashieldai.com",
  ])
  const domains = [
    "",
    ...(sharedDomainHosts.has(url.hostname.toLowerCase()) ? ["; Domain=.lyrashieldai.com"] : []),
  ]
  const headers = response.headers
  for (const name of OPTIONAL_TRACKING_COOKIES) {
    for (const domain of domains) {
      headers.append(
        "Set-Cookie",
        `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${domain}${secure ? "; Secure" : ""}`
      )
    }
  }
}
