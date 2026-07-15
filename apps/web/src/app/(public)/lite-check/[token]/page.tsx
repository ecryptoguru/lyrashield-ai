import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ShieldCheck } from "lucide-react"
import { parseLiteScorecardToken } from "@/lib/lite-scorecard"
import { ThemeToggle } from "@/components/theme-toggle"

const appOrigin = () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001"
const marketingOrigin = () => process.env.NEXT_PUBLIC_MARKETING_URL ?? appOrigin()

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  const payload = parseLiteScorecardToken(token)
  if (!payload) return { title: "Lite Check unavailable | LyraShield AI", robots: "noindex" }
  const reviewCount = payload.needsAttention + payload.worthReviewing
  const canonical = new URL(`/lite-check/${token}`, appOrigin()).toString()
  const image = new URL(`/api/og/lite-check/${token}`, appOrigin()).toString()
  const description = `${reviewCount} surface item${reviewCount === 1 ? "" : "s"} worth a look in a passive LyraShield AI Lite Check. Limited outside-only signal, not a security guarantee.`
  return {
    title: "Passive security Lite Check | LyraShield AI",
    description,
    alternates: { canonical },
    robots: { index: false, follow: false },
    openGraph: {
      title: "LyraShield AI Lite Check",
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
          alt: "LyraShield AI Lite Check summary",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "LyraShield AI Lite Check",
      description,
      images: [image],
    },
  }
}

export default async function LiteCheckPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const payload = parseLiteScorecardToken(token)
  if (!payload) notFound()
  const reviewCount = payload.needsAttention + payload.worthReviewing
  const referral = payload.referralCode
    ? `?ref=${payload.referralCode}&source=lite_scorecard`
    : "?source=lite_scorecard"
  const scanUrl = new URL(`/scan${referral}`, marketingOrigin()).toString()

  return (
    <main className="gradient-hero bg-background text-foreground min-h-screen px-4 py-6 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex min-h-12 items-center justify-between gap-4">
          <Link
            href={marketingOrigin()}
            className="flex min-h-11 items-center gap-3 font-semibold tracking-wide"
          >
            <span className="border-primary/25 bg-primary/10 flex size-10 items-center justify-center rounded-xl border">
              <ShieldCheck className="text-primary size-5" aria-hidden="true" />
            </span>
            LyraShield AI
          </Link>
          <ThemeToggle />
        </header>

        <section className="security-grid bg-card relative overflow-hidden rounded-2xl border p-6 shadow-2xl sm:p-10">
          <p className="text-primary font-mono text-xs font-semibold tracking-[0.22em] uppercase">
            Lite Check · passive public surface
          </p>
          <div className="mt-7 grid gap-8 md:grid-cols-[1.25fr_1fr] md:items-end">
            <div>
              <p className="text-primary text-7xl font-semibold tracking-tighter sm:text-8xl">
                {reviewCount}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                {reviewCount === 0
                  ? "No surface issues found"
                  : `thing${reviewCount === 1 ? "" : "s"} worth a look`}
              </h1>
              <p className="text-muted-foreground mt-4 max-w-xl leading-7">
                This card contains aggregate counters only. It does not publish the scanned URL,
                matched values, headers, findings, or exploit detail.
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-3">
              <div className="bg-background/70 rounded-xl border p-4">
                <dt className="text-muted-foreground text-xs">Needs attention</dt>
                <dd className="text-critical mt-2 text-3xl font-semibold">
                  {payload.needsAttention}
                </dd>
              </div>
              <div className="bg-background/70 rounded-xl border p-4">
                <dt className="text-muted-foreground text-xs">Review</dt>
                <dd className="text-warning mt-2 text-3xl font-semibold">
                  {payload.worthReviewing}
                </dd>
              </div>
              <div className="bg-background/70 rounded-xl border p-4">
                <dt className="text-muted-foreground text-xs">Looks OK</dt>
                <dd className="text-success mt-2 text-3xl font-semibold">{payload.looksOk}</dd>
              </div>
            </dl>
          </div>
          <div className="text-muted-foreground mt-8 border-t pt-6 text-sm leading-6">
            Surface-level and outside-only. Not the official LyraShield Score, not a full
            assessment, and not a security guarantee.
          </div>
        </section>

        <section className="bg-card mt-8 flex flex-col gap-5 rounded-2xl border p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div>
            <h2 className="text-xl font-semibold">Check an app you own</h2>
            <p className="text-muted-foreground mt-2">
              Run the same passive, read-only Lite Check with no signup.
            </p>
          </div>
          <a
            href={scanUrl}
            className="bg-primary text-primary-foreground inline-flex min-h-12 items-center justify-center rounded-lg px-5 font-semibold"
          >
            Open the free scanner
          </a>
        </section>
      </div>
    </main>
  )
}
