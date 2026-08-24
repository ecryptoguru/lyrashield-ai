import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"

// S12: Discriminated union for payout method — prevents arbitrary JSON injection
const PayoutMethodSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("razorpayx"),
      fundAccountId: z.string().regex(/^fa_[A-Za-z0-9]+$/),
      maskedDisplay: z.string().min(3).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("payoneer"),
      payeeId: z.string().min(3).max(128),
      maskedDisplay: z.string().min(3).max(64),
    })
    .strict(),
])

const MethodSchema = z
  .object({
    affiliateId: z.string().min(1),
    payoutMethod: PayoutMethodSchema,
    taxFormType: z.enum(["w9", "w8ben", "w8ben_e", "gstin"]).optional(),
  })
  .strict()

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 })
  }

  const parsed = MethodSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", details: parsed.error.issues },
      { status: 400 }
    )
  }

  // Verify ownership
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: parsed.data.affiliateId },
    select: { userId: true },
  })

  if (!affiliate || affiliate.userId !== session.userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 403 })
  }

  // Server stores only provider-hosted recipient IDs and masked display data.
  // Operator verification remains required before payout eligibility.
  await prisma.affiliate.update({
    where: { id: parsed.data.affiliateId },
    data: {
      payoutMethod: {
        ...parsed.data.payoutMethod,
        valid: false,
      },
      payoutMethodVerifiedAt: null,
      payoutMethodVerifiedBy: null,
      taxFormType: parsed.data.taxFormType,
      taxFormStatus: parsed.data.taxFormType ? "PENDING_REVIEW" : "NOT_SUBMITTED",
      taxReviewedAt: null,
      taxReviewedBy: null,
    },
  })

  return NextResponse.json({ success: true })
}
