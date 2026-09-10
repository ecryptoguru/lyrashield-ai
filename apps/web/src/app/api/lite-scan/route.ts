import { analyzeLiteSurface, checkScanUrlSafe, collectPublicSurface } from "@lyrashield/security"
import { getUrlScanProfile } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { verifyTurnstile } from "../../../lib/turnstile"
import { z } from "zod"

export const dynamic = "force-dynamic"

const bodySchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    authorized: z.literal(true),
    turnstileToken: z.string().trim().max(4096).optional(),
  })
  .strict()

const LITE_USER_AGENT = "LyraShield-Lite/2.0 (passive public-surface check)"

function trustedOrigins(): Set<string> {
  const values = [process.env.NEXT_PUBLIC_MARKETING_URL, process.env.NEXT_PUBLIC_APP_URL]
  return new Set(
    values.flatMap((value) => {
      if (!value) return []
      try {
        return [new URL(value).origin]
      } catch {
        return []
      }
    })
  )
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin")
  if (!origin || !trustedOrigins().has(origin)) return {}
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  }
}

function response(request: Request, body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}

function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin")
  return origin ? trustedOrigins().has(origin) : false
}

export function OPTIONS(request: Request): Response {
  if (!isOriginAllowed(request)) return response(request, { error: "forbidden" }, 403)
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: Request): Promise<Response> {
  if (!isOriginAllowed(request)) return response(request, { error: "forbidden" }, 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return response(request, { error: "invalid_url", message: "Enter a valid public URL." }, 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return response(
      request,
      {
        error: "invalid_url",
        message: "Enter a public URL and confirm you are authorized to scan it.",
      },
      400
    )
  }

  if (!(await verifyTurnstile(parsed.data.turnstileToken))) {
    return response(
      request,
      { error: "bot_check_failed", message: "Please retry the abuse check." },
      403
    )
  }

  const safety = await checkScanUrlSafe(parsed.data.url)
  if (!safety.safe) {
    return response(
      request,
      { error: "ssrf_blocked", message: "That URL cannot be checked from this public tool." },
      400
    )
  }

  const startedAt = Date.now()
  const profile = getUrlScanProfile("WEB_APP", "SAFE")
  const collection = await collectPublicSurface({
    seedUrl: parsed.data.url,
    profile,
    userAgent: LITE_USER_AGENT,
  })

  const document = collection.subjects.find((subject) => subject.kind === "document")
  if (!document) {
    return response(
      request,
      {
        error: "unreachable",
        message: "We could not read that public page. Check the URL and try again.",
      },
      422
    )
  }

  try {
    const publicAssetText = collection.subjects
      .filter((subject) => subject.kind === "asset")
      .map((subject) => subject.body)
      .join("\n")
    const result = analyzeLiteSurface({
      target: document.finalUrl,
      html: document.body,
      publicAssetText,
      headers: document.headers,
      status: document.status,
    })
    return response(request, { result, durationMs: Date.now() - startedAt }, 200)
  } catch (error) {
    logger.error("Lite Check failed after passive fetch", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return response(
      request,
      { error: "scan_error", message: "The passive check could not finish." },
      500
    )
  }
}
