import { getSession } from "@lyrashield/auth/server"
import { env } from "@lyrashield/config"
import { withAccountRLS } from "@lyrashield/db"
import { NextResponse } from "next/server"
import { z } from "zod"
import { withCookieMutation } from "../../../../lib/api-auth"
import { clearOptionalTrackingCookies } from "../../../../lib/analytics-preference"

const PatchBody = z.object({ analyticsEnabled: z.boolean() }).strict()
const PRIVATE_CACHE = "private, no-store"
const PREFERENCE_COOKIE = "lyrashield-analytics"
const PREFERENCE_MAX_AGE = 180 * 24 * 60 * 60

function marketingOrigin(): string | null {
  const configured = env.NEXT_PUBLIC_MARKETING_URL?.trim()
  if (!configured) return "https://lyrashieldai.com"
  try {
    return new URL(configured).origin
  } catch {
    return null
  }
}

function privateResponse(request: Request, response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", PRIVATE_CACHE)
  const origin = request.headers.get("origin")
  if (origin && origin === marketingOrigin()) {
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Access-Control-Allow-Credentials", "true")
    response.headers.append("Vary", "Origin")
  }
  return response
}

function unauthorized(status: 401 | 403 = 401): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
        message: status === 401 ? "Authentication required" : "Browser session required",
      },
    },
    { status }
  )
}

function setPreferenceCookie(response: NextResponse, request: Request, enabled: boolean): void {
  const hostname = new URL(request.url).hostname.toLowerCase()
  const sharedDomain = [
    "lyrashieldai.com",
    "www.lyrashieldai.com",
    "app.lyrashieldai.com",
  ].includes(hostname)
    ? "; Domain=.lyrashieldai.com"
    : ""
  const secure = new URL(request.url).protocol === "https:"
  response.headers.append(
    "Set-Cookie",
    `${PREFERENCE_COOKIE}=${enabled ? "on" : "off"}; Path=/; Max-Age=${PREFERENCE_MAX_AGE}; SameSite=Lax${sharedDomain}${secure ? "; Secure" : ""}`
  )
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await getSession()
    if (!session) return privateResponse(request, unauthorized())
    if (session.apiKey || session.oauth) return privateResponse(request, unauthorized(403))

    const preference = await withAccountRLS(session.userId, (tx) =>
      tx.accountPreference.findUnique({
        where: { accountId: session.userId },
        select: { analyticsEnabled: true },
      })
    )
    return privateResponse(
      request,
      NextResponse.json({
        success: true,
        data: { analyticsEnabled: preference?.analyticsEnabled ?? true },
      })
    )
  } catch {
    return privateResponse(
      request,
      NextResponse.json(
        { success: false, error: { code: "INTERNAL_ERROR", message: "Could not load preference" } },
        { status: 500 }
      )
    )
  }
}

async function patch(request: Request): Promise<NextResponse> {
  try {
    const session = await getSession()
    if (!session) return privateResponse(request, unauthorized())
    if (session.apiKey || session.oauth) return privateResponse(request, unauthorized(403))

    const body: unknown = await request.json().catch(() => null)
    const parsed = PatchBody.safeParse(body)
    if (!parsed.success) {
      return privateResponse(
        request,
        NextResponse.json(
          { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid preference" } },
          { status: 400 }
        )
      )
    }

    const preference = await withAccountRLS(session.userId, (tx) =>
      tx.accountPreference.upsert({
        where: { accountId: session.userId },
        create: { accountId: session.userId, analyticsEnabled: parsed.data.analyticsEnabled },
        update: { analyticsEnabled: parsed.data.analyticsEnabled },
        select: { analyticsEnabled: true },
      })
    )
    const response = privateResponse(
      request,
      NextResponse.json({ success: true, data: preference })
    )
    setPreferenceCookie(response, request, preference.analyticsEnabled)
    if (!preference.analyticsEnabled) {
      clearOptionalTrackingCookies(response, request)
    }
    return response
  } catch {
    const response = privateResponse(
      request,
      NextResponse.json(
        {
          success: false,
          error: { code: "INTERNAL_ERROR", message: "Could not update preference" },
        },
        { status: 500 }
      )
    )
    // A browser opt-out is honored locally even if the durable account write is
    // temporarily unavailable; the caller can retry the account save later.
    setPreferenceCookie(response, request, false)
    clearOptionalTrackingCookies(response, request)
    return response
  }
}

export const PATCH = withCookieMutation(patch)
