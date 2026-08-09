import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET() {
  const token = process.env.OPENAI_APPS_DOMAIN_VERIFICATION_TOKEN
  if (!token) return new NextResponse(null, { status: 404 })

  return new NextResponse(token, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "text/plain; charset=utf-8",
    },
  })
}
