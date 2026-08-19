import Link from "next/link"
import { redirect } from "next/navigation"
import { getCachedSession } from "@/lib/cache"
import { prisma } from "@lyrashield/db"
import { AffiliateApplyForm } from "./apply-form"

export const metadata = {
  title: "Apply — Affiliate Program — LyraShield AI",
}

export default async function AffiliateApplyPage() {
  const session = await getCachedSession()
  if (!session) {
    redirect("/sign-in?callbackURL=/affiliates/apply")
  }

  const existing = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: { id: true, status: true },
  })

  if (existing) {
    if (existing.status === "APPROVED") {
      redirect("/affiliates/dashboard")
    }
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <h1 className="text-2xl font-bold">Application Submitted</h1>
        <p className="mt-4 text-muted-foreground">
          Your affiliate application is currently{" "}
          <span className="font-semibold">{existing.status}</span>. Our team will review it and
          notify you of the decision.
        </p>
        <Link href="/" className="mt-6 inline-block text-primary hover:underline">
          Back to home
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-2 text-3xl font-bold">Affiliate Application</h1>
      <p className="mb-8 text-muted-foreground">
        Tell us about your audience and how you plan to promote LyraShield AI.
      </p>
      <AffiliateApplyForm userId={session.userId} />
    </div>
  )
}
