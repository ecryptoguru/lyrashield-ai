import { getSession } from "@lyrashield/auth/server"
import { withAccountRLS } from "@lyrashield/db"

export { clearOptionalTrackingCookies, OPTIONAL_TRACKING_COOKIES } from "./analytics-cookies"

const ANALYTICS_PREFERENCE_COOKIE = "lyrashield-analytics"

export interface AnalyticsBrowserSession {
  userId: string
  apiKey?: unknown
  oauth?: unknown
}

function browserAnalyticsPreferenceIsOff(cookieHeader: string | null): boolean {
  return (
    cookieHeader
      ?.split(";")
      .map((part) => part.trim())
      .some((part) => part === `${ANALYTICS_PREFERENCE_COOKIE}=off`) ?? false
  )
}

function requestPrivacySignalIsOff(request: Pick<Request, "headers">): boolean {
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
