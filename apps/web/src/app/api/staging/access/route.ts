import { NextResponse } from "next/server"
import {
  BILLING_STAGING_ACCESS_COOKIE,
  BILLING_STAGING_ACCESS_MAX_AGE_SECONDS,
  createBillingStagingAccessCookieValue,
  isRestrictedBillingStaging,
  isValidBillingStagingToken,
} from "@/lib/billing-staging-access"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  if (!isRestrictedBillingStaging()) return new NextResponse(null, { status: 404 })

  const expectedOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL!).origin
  if (request.headers.get("origin") !== expectedOrigin) {
    return new NextResponse(null, { status: 403 })
  }

  let token = ""
  try {
    const form = await request.formData()
    token = String(form.get("token") ?? "")
  } catch {
    return new NextResponse(null, { status: 400 })
  }
  if (!isValidBillingStagingToken(token)) {
    return new NextResponse(null, { status: 403 })
  }

  const value = createBillingStagingAccessCookieValue()
  if (!value) return new NextResponse(null, { status: 403 })
  const response = NextResponse.redirect(new URL("/sign-up", expectedOrigin), 303)
  response.cookies.set(BILLING_STAGING_ACCESS_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: BILLING_STAGING_ACCESS_MAX_AGE_SECONDS,
  })
  response.headers.set("Cache-Control", "no-store")
  return response
}
