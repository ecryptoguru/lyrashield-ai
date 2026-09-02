import { NextResponse } from "next/server"
import { hasReferralCode } from "@lyrashield/db"
import { z } from "zod"
import { REFERRAL_SOURCES } from "../../../../lib/scorecard-sharing"
import { isProd } from "@lyrashield/config"
import { assertSameOriginMutation, authErrorResponse } from "../../../../lib/api-auth"

const Source = z.enum(REFERRAL_SOURCES)
const Body = z
  .object({
    code: z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/),
    source: Source.optional().default("scorecard"),
  })
  .strict()

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request)
  } catch (error) {
    const response = authErrorResponse(error)
    if (response) return response
    throw error
  }
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ success: false }, { status: 400 })
  const valid = await hasReferralCode(parsed.data.code)
  if (!valid) return NextResponse.json({ success: false }, { status: 404 })
  const response = NextResponse.json({ success: true })
  response.cookies.set("ls_ref", parsed.data.code, {
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "strict",
    httpOnly: true,
    path: "/",
    secure: isProd,
  })
  response.cookies.set("ls_ref_source", parsed.data.source, {
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "strict",
    httpOnly: true,
    path: "/",
    secure: isProd,
  })
  return response
}
