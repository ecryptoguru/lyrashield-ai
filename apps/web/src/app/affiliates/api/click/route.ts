import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { detectAttribution } from "@lyrashield/affiliate"
import { parseAffiliateCookie } from "@lyrashield/affiliate"

const ClickSchema = z.object({
  code: z.string().min(1).max(64),
  landingUrl: z.string().url().max(2000).optional(),
  referrer: z.string().max(2000).optional(),
  subid: z.string().max(100).optional(),
})

/**
 * Async click capture endpoint.
 * Called by the client-side attribution script when a `?ref=` is detected
 * on a page that the middleware didn't catch (e.g. SPA navigation).
 */
export async function POST(request: NextRequest) {
  const parsed = ClickSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid click data" },
      { status: 400 }
    )
  }

  const searchParams = new URLSearchParams()
  searchParams.set("ref", parsed.data.code)
  if (parsed.data.subid) searchParams.set("subid", parsed.data.subid)

  const existingCookie = parseAffiliateCookie(request.headers.get("cookie"))

  const result = await detectAttribution({
    pathname: "/",
    searchParams,
    landingUrl: parsed.data.landingUrl,
    referrer: parsed.data.referrer,
    cookieToken: existingCookie,
    consentGiven: true,
  })

  const response = NextResponse.json({
    success: result.attributed,
    affiliateId: result.affiliateId,
  })

  if (result.setCookie) {
    response.headers.set("Set-Cookie", result.setCookie)
  }

  return response
}
