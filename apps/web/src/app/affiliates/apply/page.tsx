import Link from "next/link"
import { redirect } from "next/navigation"
import { getCachedSession } from "@/lib/cache"
import { prisma } from "@lyrashield/db"
import { humanizeToken } from "@/lib/labels"

export const metadata = {
  title: "Affiliate Program — Applications Open Soon — LyraShield AI",
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
          <span className="font-semibold">{humanizeToken(existing.status)}</span>. Our team will
          review it and notify you of the decision.
        </p>
        <Link href="/" className="mt-6 inline-block text-primary hover:underline">
          Back to home
        </Link>
      </div>
    )
  }

  // New admission is frozen for launch. The page stays reachable so an existing
  // applicant or an approved affiliate still resolves above. It says plainly
  // that applications are not open instead of collecting a form nothing can act on.
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-2 text-3xl font-bold">Affiliate applications open soon</h1>
      <p className="text-muted-foreground">
        The LyraShield AI affiliate program is not accepting new applications yet. We are finishing
        the review and payout controls that have to be in place before the program opens. Check back
        here for the opening date.
      </p>
      <Link href="/" className="mt-6 inline-block text-primary hover:underline">
        Back to home
      </Link>
    </div>
  )
}
