import { SCORE_MODEL_VERSION } from "@lyrashield/score"
import Link from "next/link"
import { ArrowLeft, ShieldCheck } from "lucide-react"
import { Card } from "@lyrashield/ui"
import { ThemeToggle } from "@/components/theme-toggle"

export default function ScoreMethodologyPage() {
  return (
    <main className="gradient-hero min-h-screen px-4 py-6 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex min-h-12 items-center justify-between">
          <Link href="/" className="flex min-h-11 items-center gap-2.5 font-semibold">
            <ShieldCheck className="text-primary size-5" aria-hidden="true" />
            LyraShield AI
          </Link>
          <ThemeToggle />
        </header>
        <Card className="p-6 sm:p-10">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-2 text-sm"
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> Back
          </Link>
          <h1 className="mt-5 text-3xl font-bold tracking-[-0.035em] sm:text-4xl">
            LyraShield Score methodology
          </h1>
          <p className="text-muted-foreground mt-5 leading-7">
            {SCORE_MODEL_VERSION} starts at 100 and deducts for current findings: verified critical
            −25, high −10, medium −4, low −1; unverified findings count at 25% weight and accepted
            risk at 50% weight. Verified critical findings cap the grade at C, verified highs at B,
            and active verified secrets at D. A+ additionally requires no open findings of medium
            severity or higher.
          </p>
          <p className="text-muted-foreground mt-4 leading-7">
            Scores are deterministic, versioned, and limited to the stated scan scope. They are not
            a security guarantee.
          </p>
        </Card>
      </div>
    </main>
  )
}
