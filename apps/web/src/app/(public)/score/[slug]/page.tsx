import type { Metadata } from "next"
import Link from "next/link"
import { cache } from "react"
import { notFound } from "next/navigation"
import { getPublicScorecard } from "@lyrashield/db"
import { buttonVariants } from "@lyrashield/ui"
import { CheckCircle2, ShieldCheck } from "lucide-react"
import { ScorecardShareComposer } from "../../../../components/scorecard-share-composer"
import { ReferralCapture } from "./referral-capture"

export const revalidate = 60

const getScorecard = cache(getPublicScorecard)
const appOrigin = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001"
const REFERRAL_SOURCES = new Set([
  "native",
  "linkedin",
  "x",
  "bluesky",
  "whatsapp",
  "reddit",
  "email",
  "copy",
  "embed",
])

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
  const description = `Grade ${grade} from a scoped LyraShield AI review, with ${fixes} finding${fixes === 1 ? "" : "s"} fixed and retest-verified. Not a security guarantee.`

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
  const referralSource = source && REFERRAL_SOURCES.has(source) ? source : undefined
  const shareUrl = `/score/${slug}${activeReferral ? `?ref=${activeReferral}` : ""}`
  const signupUrl = `/sign-up${activeReferral ? `?ref=${activeReferral}` : ""}`

  return (
    <main className="min-h-screen bg-[#07110f] px-4 py-8 text-[#ecfff9] sm:px-6 sm:py-14">
      <ReferralCapture code={activeReferral ?? undefined} source={referralSource} />
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3 font-semibold tracking-wide">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#4adeb2]/50 bg-[#4adeb2]/10">
              <ShieldCheck className="h-5 w-5 text-[#4adeb2]" aria-hidden="true" />
            </span>
            LyraShield AI
          </Link>
          <Link href="/score/methodology" className="text-sm text-[#9dbbb1] hover:text-[#ecfff9]">
            Scoring methodology
          </Link>
        </header>

        <section className="relative overflow-hidden rounded-2xl border border-[#4adeb2]/20 bg-[#0b1714] p-6 shadow-2xl sm:p-10">
          <div
            className="pointer-events-none absolute -top-40 right-0 h-96 w-96 rounded-full bg-[#4adeb2]/10 blur-3xl"
            aria-hidden="true"
          />
          {superseded && (
            <p className="relative mb-6 rounded-lg border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-sm text-amber-100">
              A newer qualifying scan exists. This card reflects the dated snapshot below.
            </p>
          )}
          <div className="relative grid items-end gap-8 md:grid-cols-[1fr_auto]">
            <div>
              <p className="text-sm font-medium text-[#9dbbb1]">Scoped security review</p>
              <p className="mt-4 font-mono text-8xl font-bold tracking-tighter text-[#4adeb2] sm:text-9xl">
                {grade}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">LyraShield Score</h1>
              <p className="mt-3 max-w-xl text-[#9dbbb1]">
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
            <div className="min-w-64 rounded-xl border border-[#4adeb2]/15 bg-black/15 p-5">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-[#4adeb2]" aria-hidden="true" />
                Retest-confirmed progress
              </p>
              <p className="mt-3 text-4xl font-semibold">{payload.resolvedFindings}</p>
              <p className="mt-1 text-sm text-[#9dbbb1]">
                finding{payload.resolvedFindings === 1 ? "" : "s"} fixed and verified
              </p>
            </div>
          </div>
          <div className="relative mt-8 flex flex-wrap items-center gap-3 border-t border-[#4adeb2]/10 pt-6">
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
          <p className="relative mt-5 text-xs text-[#78958c]">
            Methodology {payload.modelVersion}. This score is limited to the scope and date above
            and is not a security guarantee.
          </p>
        </section>

        <div className="dark text-foreground mt-8">
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
