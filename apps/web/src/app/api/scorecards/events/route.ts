import { recordScorecardEvent } from "@lyrashield/db"
import { z } from "zod"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { SCORECARD_CHANNELS } from "../../../../lib/scorecard-sharing"
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"

const VISITOR_COOKIE = "ls_scorecard_visitor"

const Body = z
  .object({
    slug: z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/),
    eventType: z.enum(["VIEW", "SHARE"]),
    channel: z.enum(SCORECARD_CHANNELS).optional(),
    variant: z.enum(["grade", "fixes"]).default("grade"),
    source: z.enum(["dashboard", "public"]).default("public"),
    visitorId: z.uuid().optional(),
  })
  .strict()

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return apiError("INVALID_PARAM", "Invalid scorecard event", 400)
  if (parsed.data.eventType === "SHARE" && !parsed.data.channel) {
    return apiError("INVALID_PARAM", "Share channel is required", 400)
  }
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) return apiError("INTERNAL_ERROR", "Scorecard analytics unavailable", 500)
  const existing = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${VISITOR_COOKIE}=`))
    ?.slice(VISITOR_COOKIE.length + 1)
  const visitorId = verifyVisitorToken(existing, secret) ?? randomUUID()
  const result = await recordScorecardEvent(parsed.data.slug, {
    eventType: parsed.data.eventType,
    channel: parsed.data.channel,
    variant: parsed.data.variant,
    source: parsed.data.source,
    visitorId,
  })
  if (!result) return apiError("SCORECARD_NOT_FOUND", "Scorecard not found", 404)
  const response = apiSuccess(result, 201)
  response.cookies.set(VISITOR_COOKIE, signVisitorToken(visitorId, secret), {
    maxAge: 365 * 24 * 60 * 60,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  })
  return response
}

function signVisitorToken(visitorId: string, secret: string): string {
  return `${visitorId}.${createHmac("sha256", secret).update(visitorId).digest("hex")}`
}

function verifyVisitorToken(token: string | undefined, secret: string): string | null {
  if (!token) return null
  const separator = token.lastIndexOf(".")
  if (separator < 1) return null
  const visitorId = token.slice(0, separator)
  if (!z.uuid().safeParse(visitorId).success) return null
  const signature = token.slice(separator + 1)
  const expected = createHmac("sha256", secret).update(visitorId).digest("hex")
  if (signature.length !== expected.length) return null
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? visitorId : null
}
