import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"

// S12: Discriminated union for payout method — prevents arbitrary JSON injection
// C-M03: Include tax and provider-specific fields that were previously stripped.
const PayoutMethodSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("razorpayx"),
    accountNumber: z.string().min(1),
    ifsc: z.string().min(1),
    beneficiaryName: z.string().min(1),
    // C-M03: UPI ID for RazorpayX UPI payouts
    upiId: z.string().optional(),
  }),
  z.object({
    type: z.literal("payoneer"),
    email: z.string().email(),
    // C-M03: Country for Payoneer routing
    country: z.string().max(2).optional(),
  }),
  z.object({
    type: z.literal("briskpe"),
    accountNumber: z.string().min(1),
    ifsc: z.string().min(1),
    beneficiaryName: z.string().min(1),
    // C-M03: UPI ID for BriskPe UPI payouts
    upiId: z.string().optional(),
  }),
])

const MethodSchema = z.object({
  affiliateId: z.string().min(1),
  payoutMethod: PayoutMethodSchema,
  // C-M03: Tax form fields — previously stripped by Zod, blocking payout eligibility
  taxFormComplete: z.boolean().optional(),
  taxFormType: z.enum(["w9", "w8ben", "w8ben_e"]).optional(),
})

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

  // S10: Server-side sets valid: false — never trust client self-attestation.
  // The valid flag is only set to true after a manual verification process.
  // C-M03: Preserve taxFormComplete and taxFormType from the client, but
  // taxFormComplete is always overridden to false (C-M08) — only admin sets true.
  await prisma.affiliate.update({
    where: { id: parsed.data.affiliateId },
    data: {
      payoutMethod: {
        ...parsed.data.payoutMethod,
        valid: false,
        // C-M08: Never trust client taxFormComplete — always false until admin verifies
        taxFormComplete: false,
        // Preserve taxFormType if provided (the type of form, not completion status)
        ...(parsed.data.taxFormType && { taxFormType: parsed.data.taxFormType }),
      },
    },
  })

  return NextResponse.json({ success: true })
}
