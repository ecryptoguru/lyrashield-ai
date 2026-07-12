import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { z } from "zod"

const Body = z.object({ code: z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/) })

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ success: false }, { status: 400 })
  const valid = await prisma.referralCode.findUnique({
    where: { code: parsed.data.code },
    select: { id: true },
  })
  if (!valid) return NextResponse.json({ success: false }, { status: 404 })
  const response = NextResponse.json({ success: true })
  response.cookies.set("ls_ref", parsed.data.code, {
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "lax",
    httpOnly: false,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  })
  return response
}
