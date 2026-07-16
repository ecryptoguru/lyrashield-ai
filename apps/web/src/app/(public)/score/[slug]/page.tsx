import type { Metadata } from "next"
import Link from "next/link"
import { cache } from "react"
import { notFound } from "next/navigation"
import { getPublicScorecard } from "@lyrashield/db"
import { buttonVariants } from "@lyrashield/ui"
import { CheckCircle2, ShieldCheck } from "lucide-react"
import { ScorecardShareComposer } from "../../../../components/scorecard-share-composer"
import { ReferralCapture } from "./referral-capture"
import { REFERRAL_SOURCES } from "../../../../lib/scorecard-sharing"
import { ThemeToggle } from "@/components/theme-toggle"

export const revalidate = 60

const getScorecard = cache(getPublicScorecard)
const appOrigin = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001"
const REFERRAL_SOURCE_SET = new Set<string>(REFERRAL_SOURCES)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const scorecard = await getScorecard(slug)
  if (!scorecard) return { title: "Scorecard unavailable | LyraShield AI", robots: "noindex" }

  const grade = scorecard.payload.grade.replace("_PLUS", "+")
  const fixes = scorecard.payload.resolvedFindings
  const variant = ["A+", "A", "B"].includes(grade) ? "grade" : "fixes"
  const canonical = new URL(`/score/${slug}`, appOrigin()).toString()
  const image = new URL(
    `/api/og/score/${slug}?variant=${variant}&format=wide`,
    appOrigin()
  ).toString()
  const description = `Grade ${grade} from a scoped LyraShield AI review, with ${fixes} finding${fixes === 1 ? "" : "s"} fixed and retest-confirmed. Not a security guarantee.`

  return {
    title: `Grade ${grade} security review | LyraShield AI`,
    description,
    alternates: { canonical },
    robots: { index: false, follow: false },
    openGraph: {
      title: `LyraShield Score: ${grade}`,
      description,
      type: "website",
      url: canonical,
      siteName: "LyraShield AI",
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          type: "image/png",
          alt: `LyraShield Score grade ${grade}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `LyraShield Score: ${grade}`,
      description,
      images: [{ url: image, alt: `LyraShield Score grade ${grade}` }],
    },
  }
}

export default async function ScorecardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ ref?: string; source?: string }>
}) {
  const { slug } = await params
  const { ref, source } = await searchParams
  const scorecard = await getScorecard(slug)
  if (!scorecard) notFound()

  const { payload, referralCode, superseded } = scorecard
  const grade = payload.grade.replace("_PLUS", "+")
  const activeReferral = ref ?? referralCode
  const referralSource = source && REFERRAL_SOURCE_SET.has(source) ? source : undefined
  const shareUrl = `/score/${slug}${activeReferral ? `?ref=${activeReferral}` : ""}`
  const signupUrl = `/sign-up${activeReferral ? `?ref=${activeReferral}` : ""}`

  return (
    <main className="gradient-hero bg-background text-foreground min-h-screen px-4 py-6 sm:px-6 sm:py-12">
      <ReferralCapture code={activeReferral ?? undefined} source={referralSource} />
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex min-h-12 items-center justify-between gap-4">
          <Link href="/" className="flex min-h-11 items-center gap-3 font-semibold tracking-wide">
            <span className="bg-primary/10 border-primary/25 flex size-10 items-center justify-center rounded-xl border">
              <ShieldCheck className="text-primary size-5" aria-hidden="true" />
            </span>
            LyraShield AI
          </Link>
          <div className="flex items-center gap-1">
            <Link
              href="/score/methodology"
              className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center rounded-lg px-3 text-sm"
            >
              Methodology
            </Link>
            <ThemeToggle />
          </div>
        </header>

        <section className="security-grid bg-card relative overflow-hidden rounded-2xl border p-6 shadow-2xl sm:p-10">
          <div
            className="bg-primary/10 pointer-events-none absolute -top-40 right-0 size-96 rounded-full blur-3xl"
            aria-hidden="true"
          />
          {superseded && (
            <p className="relative mb-6 rounded-lg border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-sm text-amber-800 dark:text-amber-100">
              A newer qualifying scan exists. This card reflects the dated snapshot below.
            </p>
          )}
          <div className="relative grid items-end gap-8 md:grid-cols-[1fr_auto]">
            <div>
              <p className="text-muted-foreground text-sm font-medium">Scoped security review</p>
              <p className="text-primary mt-4 font-mono text-8xl font-bold tracking-tighter sm:text-9xl">
                {grade}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">LyraShield Score</h1>
              <p className="text-muted-foreground mt-3 max-w-xl">
                {payload.scope}, scanned{" "}
                {new Date(payload.scannedAt).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })}
                .
              </p>
            </div>
            <div className="bg-muted/45 min-w-64 rounded-xl border p-5">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="text-success size-4" aria-hidden="true" />
                Retest-confirmed progress
              </p>
              <p className="mt-3 text-4xl font-semibold">{payload.resolvedFindings}</p>
              <p className="text-muted-foreground mt-1 text-sm">
                finding{payload.resolvedFindings === 1 ? "" : "s"} fixed and retest-confirmed
              </p>
            </div>
          </div>
          <div className="relative mt-8 flex flex-wrap items-center gap-3 border-t pt-6">
            <Link href={signupUrl} className={buttonVariants({ size: "lg" })}>
              Check my app before launch
            </Link>
            <Link
              href="/score/methodology"
              className={buttonVariants({ size: "lg", variant: "ghost" })}
            >
              See how scoring works
            </Link>
          </div>
          <p className="text-muted-foreground relative mt-5 text-xs">
            Methodology {payload.modelVersion}. This score is limited to the scope and date above
            and is not a security guarantee.
          </p>
        </section>

        <div className="text-foreground mt-8">
          <ScorecardShareComposer
            slug={slug}
            url={shareUrl}
            grade={grade}
            resolvedFindings={payload.resolvedFindings}
            source="public"
          />
        </div>
      </div>
    </main>
  )
}
