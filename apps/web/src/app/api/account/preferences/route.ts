import { getSession } from "@lyrashield/auth/server"
import { env } from "@lyrashield/config"
import { withAccountRLS } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"
import { z } from "zod"
import { withCookieMutation } from "../../../../lib/api-auth"
import { clearOptionalTrackingCookies } from "../../../../lib/analytics-preference"

const PatchBody = z.object({ analyticsEnabled: z.boolean() }).strict()
const PRIVATE_CACHE = "private, no-store"
const PREFERENCE_COOKIE = "lyrashield-analytics"
const PREFERENCE_MAX_AGE = 180 * 24 * 60 * 60

type CauseClassification =
  "connection_timeout" | "connection_interrupted" | "authentication" | "database" | "unknown"

const ERROR_CLASSES = new Set([
  "Error",
  "AggregateError",
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientInitializationError",
  "PrismaClientRustPanicError",
  "PrismaClientValidationError",
  "TimeoutError",
])
const POSTGRES_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "28P01",
  "28000",
  "40001",
  "40P01",
  "42501",
  "42P01",
  "53300",
  "57P01",
  "57P02",
  "57P03",
])

function sanitizedDatabaseFailure(error: unknown): {
  errorClass: string
  databaseCode: string | null
  causeClassification: CauseClassification
  transportCode?: "ETIMEDOUT"
} {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    chain.push(current)
    current = "cause" in current ? current.cause : null
  }

  const root = chain[0]
  const name = root && typeof root === "object" && "name" in root ? root.name : null
  const errorClass = typeof name === "string" && ERROR_CLASSES.has(name) ? name : "OtherError"
  const codes = chain.map((item) =>
    item && typeof item === "object" && "code" in item ? item.code : null
  )
  const databaseCode = codes.find(
    (code): code is string =>
      typeof code === "string" && (/^P\d{4}$/.test(code) || POSTGRES_CODES.has(code))
  )
  const transportCode = codes.some((code) => code === "ETIMEDOUT") ? "ETIMEDOUT" : null
  const safeCodes = new Set(codes.filter((code): code is string => typeof code === "string"))
  const messages = chain.map((item) =>
    item && typeof item === "object" && "message" in item && typeof item.message === "string"
      ? item.message.toLowerCase()
      : ""
  )
  let causeClassification: CauseClassification = "unknown"
  if (
    safeCodes.has("ETIMEDOUT") ||
    safeCodes.has("P1001") ||
    messages.some((message) => /timeout|timed out/.test(message))
  ) {
    causeClassification = "connection_timeout"
  } else if (
    ["ECONNRESET", "ECONNREFUSED", "08006", "08001", "57P01"].some((code) => safeCodes.has(code)) ||
    messages.some((message) =>
      /connection terminated|connection reset|socket hang up/.test(message)
    )
  ) {
    causeClassification = "connection_interrupted"
  } else if (
    ["28P01", "28000", "P1000"].some((code) => safeCodes.has(code)) ||
    messages.some((message) => /authentication failed|password authentication/.test(message))
  ) {
    causeClassification = "authentication"
  } else if (databaseCode || chain.length > 0) {
    causeClassification = "database"
  }

  return {
    errorClass,
    databaseCode: databaseCode ?? null,
    causeClassification,
    ...(transportCode ? { transportCode } : {}),
  }
}

function logPreferenceFailure(
  method: "GET" | "PATCH",
  phase: "session_lookup" | "preference_read" | "preference_write",
  error: unknown
): void {
  const action = method === "GET" ? "read" : "update"
  logger.error(`Account preference ${action} failed`, {
    eventCode: `ACCOUNT_PREFERENCE_${method}_FAILED`,
    phase,
    ...sanitizedDatabaseFailure(error),
  })
}

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
  let phase: "session_lookup" | "preference_read" = "session_lookup"
  try {
    const session = await getSession()
    if (!session) return privateResponse(request, unauthorized())
    if (session.apiKey || session.oauth) return privateResponse(request, unauthorized(403))

    phase = "preference_read"
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
  } catch (error) {
    logPreferenceFailure("GET", phase, error)
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
  let phase: "session_lookup" | "preference_write" = "session_lookup"
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

    phase = "preference_write"
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
  } catch (error) {
    logPreferenceFailure("PATCH", phase, error)
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
