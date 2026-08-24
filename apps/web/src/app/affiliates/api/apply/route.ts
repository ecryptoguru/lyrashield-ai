import { NextResponse } from "next/server"
import { z } from "zod"
import { createHash } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { getCachedSession } from "@/lib/cache"
import { detectFraudSignals, AFFILIATE_TERMS_VERSION } from "@lyrashield/affiliate"

// C-M10: IP / user-agent hashing for fraud-signal signup counts. Mirrors the
// salted SHA-256 used by the click route so the hashes match across routes.
function hashIp(value: string): string {
  const salt = process.env.IP_HASH_SALT ?? "lyrashield-ip-salt-v1"
  return createHash("sha256")
    .update(value + salt)
    .digest("hex")
}

function getClientIp(request: Request): string | undefined {
  const headers = ["cf-connecting-ip", "true-client-ip", "x-real-ip", "x-forwarded-for"]
  for (const header of headers) {
    const value = request.headers.get(header)
    if (value) {
      const ip = value.split(",")[0]?.trim()
      if (ip) return ip
    }
  }
  return undefined
}

const ApplySchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).max(100),
  website: z.string().url().max(500),
  audienceSize: z.enum(["<1k", "1k-10k", "10k-50k", "50k-100k", "100k+"]),
  audienceType: z.enum(["developers", "security", "devops", "founders", "mixed"]),
  promotionMethods: z.string().min(10).max(2000),
  payoutMethod: z.enum(["razorpayx", "payoneer", "briskpe"]),
  // C-L10: Binding terms acceptance — the affiliate must affirmatively accept
  // the program terms (FTC/ASA disclosure, no-FUD, no "only-we"/benchmark
  // claims, no brand bidding). Approval is gated on this being true. A truthy
  // string ("true", "on", "1") is accepted because unchecked HTML checkboxes
  // submit nothing, so we require the checkbox to be explicitly checked.
  acceptTerms: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "on" || v === "1")
    .refine((v) => v === true, "You must accept the affiliate program terms to apply"),
  taxFormStatus: z.enum(["will_complete", "have_w9", "have_w8ben", "have_w8ben_e", "have_gstin"]),
})

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 })
  }

  // C-L09: CSRF protection — verify Origin/Referer header matches the app URL
  // for form POST submissions. This prevents cross-site form submission attacks.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) {
    const origin = request.headers.get("origin")
    const referer = request.headers.get("referer")
    const allowedOrigin = new URL(appUrl).origin
    if (origin && new URL(origin).origin !== allowedOrigin) {
      return NextResponse.json(
        { success: false, error: "Cross-origin form submission not allowed" },
        { status: 403 }
      )
    }
    if (referer && new URL(referer).origin !== allowedOrigin) {
      return NextResponse.json(
        { success: false, error: "Cross-origin form submission not allowed" },
        { status: 403 }
      )
    }
  }

  const formData = await request.formData().catch(() => null)
  if (!formData) {
    return NextResponse.json({ success: false, error: "Invalid form data" }, { status: 400 })
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
    return NextResponse.json({ success: false, error: "You have already applied" }, { status: 409 })
  }

  // S9: Fraud signal detection — reject applications with high-severity signals
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  })

  if (user) {
    // C-M10: Populate signupCountByIp / signupCountByDevice so the RATE_LIMIT_IP and
    // RATE_LIMIT_DEVICE signals actually evaluate (previously only the disposable-
    // email check ran). Hash the applicant's IP the same way the click route
    // does (salted SHA-256) and count prior Clicks from that IP / user-agent hash.
    const clientIp = getClientIp(request)
    const ipHash = clientIp ? hashIp(clientIp) : undefined
    const userAgent = request.headers.get("user-agent")
    const userAgentHash = userAgent ? hashIp(userAgent) : undefined
    const [signupCountByIp, signupCountByDevice] = await Promise.all([
      ipHash ? prisma.click.count({ where: { ipHash } }) : Promise.resolve(0),
      userAgentHash
        ? prisma.click.count({ where: { userAgent: userAgentHash } })
        : Promise.resolve(0),
    ])

    const fraudResult = detectFraudSignals({
      email: user.email,
      ipHash,
      userAgent: userAgentHash,
      signupCountByIp,
      signupCountByDevice,
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
  const submittedTaxForm = parsed.data.taxFormStatus.startsWith("have_")
  const taxFormType = submittedTaxForm ? parsed.data.taxFormStatus.replace("have_", "") : undefined
  const affiliate = await prisma.affiliate.create({
    data: {
      userId: session.userId,
      status: "PENDING",
      // C-L10: Record binding terms acceptance (versioned) at application time.
      acceptedTermsAt: new Date(),
      termsVersion: AFFILIATE_TERMS_VERSION,
      payoutMethod: {
        type: parsed.data.payoutMethod,
        valid: false,
        application: {
          name: parsed.data.name,
          website: parsed.data.website,
          audienceSize: parsed.data.audienceSize,
          audienceType: parsed.data.audienceType,
          promotionMethods: parsed.data.promotionMethods,
        },
      },
      taxFormType,
      taxFormStatus: submittedTaxForm ? "PENDING_REVIEW" : "NOT_SUBMITTED",
    },
  })

  logger.info("Affiliate application submitted", {
    affiliateId: affiliate.id,
    userId: session.userId,
  })

  return NextResponse.json({ success: true, affiliateId: affiliate.id }, { status: 201 })
}
