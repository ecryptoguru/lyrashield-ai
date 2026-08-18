import { NextResponse } from "next/server"
import { z } from "zod"
import { requestPayout } from "@lyrashield/affiliate"
import { getCachedSession } from "@/lib/cache"
import { prisma } from "@lyrashield/db"

const RequestSchema = z.object({
  affiliateId: z.string().min(1),
})

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 })
  }

  const parsed = RequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 })
  }

  // Verify ownership
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: parsed.data.affiliateId },
    select: { userId: true, status: true, payoutMethod: true },
  })

  if (!affiliate || affiliate.userId !== session.userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 403 })
  }

  if (affiliate.status !== "APPROVED") {
    return NextResponse.json({ success: false, error: "Affiliate not approved" }, { status: 403 })
  }

  // Determine provider from payout method
  const method = affiliate.payoutMethod as { type?: string } | null
  const provider = method?.type ?? "manual"

  const result = await requestPayout({
    affiliateId: parsed.data.affiliateId,
    provider,
  })

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  }

  return NextResponse.json({
    success: true,
    payoutId: result.payoutId,
    amount: result.amount,
  })
}
