import Link from "next/link"
import { notFound } from "next/navigation"
import { getPublicScorecard } from "@lyrashield/db"
import { ReferralCapture } from "./referral-capture"

export const revalidate = 3600

export default async function ScorecardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ ref?: string }>
}) {
  const { slug } = await params
  const { ref } = await searchParams
  const scorecard = await getPublicScorecard(slug)
  if (!scorecard) notFound()
  const { payload, referralCode, superseded } = scorecard
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-16">
      <ReferralCapture code={ref} />
      <section className="bg-card w-full rounded-2xl border p-8 shadow-sm sm:p-12">
        <p className="text-muted-foreground text-sm font-medium">Scanned by LyraShield AI</p>
        {superseded && (
          <p className="text-muted-foreground mt-3 rounded-md border px-3 py-2 text-xs">
            A newer scan of this target exists — this card reflects the scan date below.
          </p>
        )}
        <p className="text-primary mt-4 font-mono text-8xl font-bold tracking-tighter">
          {payload.grade.replace("_PLUS", "+")}
        </p>
        <h1 className="mt-5 text-2xl font-semibold">LyraShield Score</h1>
        <p className="text-muted-foreground mt-2">
          Scope: {payload.scope}, as of {new Date(payload.scannedAt).toLocaleDateString()}.
        </p>
        <p className="text-muted-foreground mt-4 text-sm">
          {payload.resolvedFindings} finding{payload.resolvedFindings === 1 ? "" : "s"} fixed and
          retest-verified.
        </p>
        <p className="text-muted-foreground mt-8 text-xs">
          Methodology: {payload.modelVersion}. This score is scoped to the scan above and is not a
          security guarantee.
        </p>
        <Link
          href="/score/methodology"
          className="text-primary mt-3 inline-block text-sm font-medium hover:underline"
        >
          Read the methodology
        </Link>
        {(ref ?? referralCode) && (
          <Link
            href={`/sign-up?ref=${ref ?? referralCode}`}
            className="text-primary ml-5 text-sm font-medium hover:underline"
          >
            Try LyraShield AI
          </Link>
        )}
      </section>
    </main>
  )
}
