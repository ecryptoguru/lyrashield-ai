import Link from "next/link"
import { ShieldCheck, Zap, FileCheck, GitBranch } from "lucide-react"
import { buttonVariants } from "@lyrashield/ui"

const features = [
  {
    icon: ShieldCheck,
    title: "Verified findings, not noisy alerts",
    description: "LyraShield verifies every vulnerability with safe proof before reporting.",
  },
  {
    icon: Zap,
    title: "Fast security feedback",
    description: "Check your PR or test your app in minutes, not days.",
  },
  {
    icon: FileCheck,
    title: "Fix PRs and retest workflow",
    description: "Generate fix proposals, create PRs, and retest with one click.",
  },
  {
    icon: GitBranch,
    title: "One-click onboarding",
    description: "Connect GitHub or paste a URL. No complex setup required.",
  },
]

export default function MarketingPage() {
  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Gradient background */}
      <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />

      {/* Floating glassmorphic navbar */}
      <header className="sticky top-4 z-50 px-4">
        <div className="glass mx-auto flex max-w-5xl items-center justify-between rounded-xl border px-4 py-3 shadow-md">
          <div className="flex items-center gap-2">
            <div className="gradient-primary flex h-8 w-8 items-center justify-center rounded-lg">
              <ShieldCheck className="text-primary-foreground h-5 w-5" aria-hidden="true" />
            </div>
            <span className="text-lg font-bold">LyraShield</span>
          </div>
          <nav className="flex items-center gap-2 sm:gap-4" aria-label="Main navigation">
            <Link
              href="/sign-in"
              className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
            >
              Sign in
            </Link>
            <Link href="/sign-up" className={buttonVariants({ size: "sm" })}>
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative flex flex-1 flex-col items-center justify-center px-4 py-20">
        <div className="mx-auto max-w-4xl text-center">
          <div className="bg-card/50 text-muted-foreground mb-6 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-medium shadow-sm backdrop-blur-sm">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
            AI-verified security scans for AI-built software
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Secure your app with <span className="text-gradient">AI-verified security scans</span>
          </h1>
          <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-base sm:text-lg">
            Connect a GitHub repo or paste an app URL. LyraShield safely scans it, verifies real
            vulnerabilities, explains the risk, and helps create fix PRs.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
              Start your first scan
            </Link>
            <Link href="/sign-in" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Sign in
            </Link>
          </div>
        </div>

        <div className="mt-24 grid w-full max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group bg-card rounded-xl border p-6 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-lg"
            >
              <div className="bg-primary/5 group-hover:bg-primary/10 mb-4 flex h-11 w-11 items-center justify-center rounded-xl transition-colors">
                <feature.icon className="text-primary h-6 w-6" aria-hidden="true" />
              </div>
              <h3 className="mb-2 font-semibold">{feature.title}</h3>
              <p className="text-muted-foreground text-sm">{feature.description}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="relative border-t py-8">
        <div className="text-muted-foreground mx-auto max-w-5xl px-4 text-center text-sm">
          LyraShield — AI AppSec Agent Platform
        </div>
      </footer>
    </div>
  )
}
