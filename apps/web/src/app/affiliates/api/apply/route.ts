import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { getCachedSession } from "@/lib/cache"
import { detectFraudSignals } from "@lyrashield/affiliate"

const ApplySchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).max(100),
  website: z.string().url().max(500),
  audienceSize: z.enum(["<1k", "1k-10k", "10k-50k", "50k-100k", "100k+"]),
  audienceType: z.enum(["developers", "security", "devops", "founders", "mixed"]),
  promotionMethods: z.string().min(10).max(2000),
  payoutMethod: z.enum(["razorpayx", "payoneer", "briskpe"]),
  taxFormStatus: z.enum(["will_complete", "have_w9", "have_w8ben", "have_w8ben_e"]),
})

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    )
  }

  const formData = await request.formData().catch(() => null)
  if (!formData) {
    return NextResponse.json(
      { success: false, error: "Invalid form data" },
      { status: 400 }
    )
  }

  const data = Object.fromEntries(formData.entries())
  const parsed = ApplySchema.safeParse({
    ...data,
    userId: session.userId, // Always use session userId, not form
  })

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid application data", details: parsed.error.issues },
      { status: 400 }
    )
  }

  // Check if already applied
  const existing = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: { id: true },
  })

  if (existing) {
    return NextResponse.json(
      { success: false, error: "You have already applied" },
      { status: 409 }
    )
  }

  // S9: Fraud signal detection — reject applications with high-severity signals
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  })

  if (user) {
    // Count existing signups/applications from the same user email domain
    const fraudResult = detectFraudSignals({
      email: user.email,
    })

    if (fraudResult.block) {
      logger.warn("Affiliate application blocked by fraud signals", {
        userId: session.userId,
        signals: fraudResult.signals.map((s) => s.type),
      })
      return NextResponse.json(
        { success: false, error: "Application rejected due to risk signals" },
        { status: 403 }
      )
    }
  }

  // Create the affiliate application
  // C-M08: taxFormComplete is always false server-side — never self-attested.
  // Only admin/automation sets it to true after verifying the tax form.
  const affiliate = await prisma.affiliate.create({
    data: {
      userId: session.userId,
      status: "PENDING",
      payoutMethod: {
        type: parsed.data.payoutMethod,
        valid: false,
        taxFormComplete: false,
        application: {
          name: parsed.data.name,
          website: parsed.data.website,
          audienceSize: parsed.data.audienceSize,
          audienceType: parsed.data.audienceType,
          promotionMethods: parsed.data.promotionMethods,
          taxFormStatus: parsed.data.taxFormStatus,
        },
      },
    },
  })

  logger.info("Affiliate application submitted", {
    affiliateId: affiliate.id,
    userId: session.userId,
  })

  return NextResponse.json(
    { success: true, affiliateId: affiliate.id },
    { status: 201 }
  )
}
