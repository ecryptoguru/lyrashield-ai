import { buildLiteScorecardPayload } from "@lyrashield/security"
import { z } from "zod"
import { createLiteScorecardToken } from "../../../lib/lite-scorecard"

export const dynamic = "force-dynamic"

const schema = z
  .object({
    needsAttention: z.number().int().min(0).max(50),
    worthReviewing: z.number().int().min(0).max(50),
    looksOk: z.number().int().min(0).max(50),
    referralCode: z
      .string()
      .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/)
      .optional(),
  })
  .strict()

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin")
  if (!origin) return null
  const allowed = [process.env.NEXT_PUBLIC_MARKETING_URL, process.env.NEXT_PUBLIC_APP_URL]
    .filter(Boolean)
    .map((value) => new URL(value!).origin)
  return allowed.includes(origin) ? origin : null
}

function headers(request: Request): Record<string, string> {
  const origin = allowedOrigin(request)
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
        "Cache-Control": "no-store",
      }
    : { "Cache-Control": "no-store" }
}

export function OPTIONS(request: Request) {
  if (request.headers.get("origin") && !allowedOrigin(request)) {
    return Response.json({ error: "forbidden" }, { status: 403 })
  }
  return new Response(null, { status: 204, headers: headers(request) })
}

export async function POST(request: Request) {
  if (request.headers.get("origin") && !allowedOrigin(request)) {
    return Response.json({ error: "forbidden" }, { status: 403 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid_input" }, { status: 400, headers: headers(request) })
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400, headers: headers(request) })
  }

  const payload = buildLiteScorecardPayload(parsed.data)
  const token = createLiteScorecardToken(payload)
  return Response.json(
    { url: `/lite-check/${token}`, imageUrl: `/api/og/lite-check/${token}` },
    { status: 201, headers: headers(request) }
  )
}
