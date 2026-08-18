import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"

const MethodSchema = z.object({
  affiliateId: z.string().min(1),
  payoutMethod: z.record(z.string(), z.unknown()),
})

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    )
  }

  const parsed = MethodSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request" },
      { status: 400 }
    )
  }

  // Verify ownership
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: parsed.data.affiliateId },
    select: { userId: true },
  })

  if (!affiliate || affiliate.userId !== session.userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 403 }
    )
  }

  await prisma.affiliate.update({
    where: { id: parsed.data.affiliateId },
    data: { payoutMethod: parsed.data.payoutMethod },
  })

  return NextResponse.json({ success: true })
}
