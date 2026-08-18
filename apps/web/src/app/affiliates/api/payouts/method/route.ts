import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"

// S12: Discriminated union for payout method — prevents arbitrary JSON injection
const PayoutMethodSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("razorpayx"),
    accountNumber: z.string().min(1),
    ifsc: z.string().min(1),
    beneficiaryName: z.string().min(1),
  }),
  z.object({
    type: z.literal("payoneer"),
    email: z.string().email(),
  }),
  z.object({
    type: z.literal("briskpe"),
    accountNumber: z.string().min(1),
    ifsc: z.string().min(1),
    beneficiaryName: z.string().min(1),
  }),
])

const MethodSchema = z.object({
  affiliateId: z.string().min(1),
  payoutMethod: PayoutMethodSchema,
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
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 403 }
    )
  }

  // S10: Server-side sets valid: false — never trust client self-attestation.
  // The valid flag is only set to true after a manual verification process.
  await prisma.affiliate.update({
    where: { id: parsed.data.affiliateId },
    data: {
      payoutMethod: {
        ...parsed.data.payoutMethod,
        valid: false,
      },
    },
  })

  return NextResponse.json({ success: true })
}
