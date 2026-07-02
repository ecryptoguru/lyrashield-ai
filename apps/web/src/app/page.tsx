import Link from "next/link"
import { ShieldCheck, Zap, FileCheck, GitBranch } from "lucide-react"

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
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="text-lg font-bold">LyraShield</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link
              href="/sign-in"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-4">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
            Secure your app with{" "}
            <span className="text-primary">AI-verified security scans</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground sm:text-xl">
            Connect a GitHub repo or paste an app URL. LyraShield safely scans it,
            verifies real vulnerabilities, explains the risk, and helps create fix PRs.
          </p>
          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:justify-center">
            <Link
              href="/sign-up"
              className="rounded-md bg-primary px-6 py-3 text-base font-medium text-primary-foreground hover:bg-primary/90"
            >
              Start your first scan
            </Link>
            <Link
              href="/sign-in"
              className="rounded-md border px-6 py-3 text-base font-medium hover:bg-accent"
            >
              Sign in
            </Link>
          </div>
        </div>

        <div className="mt-20 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <div key={feature.title} className="rounded-lg border p-6">
              <feature.icon className="mb-4 h-8 w-8 text-primary" />
              <h3 className="mb-2 font-semibold">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t py-8">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          LyraShield — AI AppSec Agent Platform
        </div>
      </footer>
    </div>
  )
}
