import { NextResponse } from "next/server"
import { z } from "zod"
import { randomBytes } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"

const CreateLinkSchema = z.object({
  affiliateId: z.string().min(1),
  campaign: z.string().min(1).max(100),
  subid: z.string().max(100).optional(),
})

function generateCode(): string {
  return randomBytes(6).toString("base64url").slice(0, 8).toUpperCase()
}

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    )
  }

  const parsed = CreateLinkSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request" },
      { status: 400 }
    )
  }

  // Verify the affiliate belongs to the session user
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: parsed.data.affiliateId },
    select: { userId: true, status: true },
  })

  if (!affiliate || affiliate.userId !== session.userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 403 }
    )
  }

  if (affiliate.status !== "APPROVED") {
    return NextResponse.json(
      { success: false, error: "Affiliate not approved" },
      { status: 403 }
    )
  }

  // Generate a unique code
  let code = generateCode()
  let attempts = 0
  while (attempts < 5) {
    const existing = await prisma.affiliateLink.findUnique({
      where: { code },
      select: { id: true },
    })
    if (!existing) break
    code = generateCode()
    attempts++
  }

  const link = await prisma.affiliateLink.create({
    data: {
      affiliateId: parsed.data.affiliateId,
      code,
      campaign: parsed.data.campaign,
      subid: parsed.data.subid ?? null,
    },
  })

  return NextResponse.json({ success: true, linkId: link.id, code })
}
