import Link from "next/link"
import { ShieldCheck, CheckCircle2 } from "lucide-react"

/**
 * Premium split-screen auth shell (Batch F2). Form on the left, a calm product
 * panel on the right at md+; stacks (panel hidden) below md. The panel is the
 * trust moment: a security product asking for repo access should say what it
 * does and why it's safe before asking for credentials. Proof points mirror
 * the landing methodology, kept honest — no "only we" claims.
 */

const PROOF_POINTS = [
  "Verified findings, not scanner noise",
  "Approval-bound fixes — nothing merges without your sign-off",
  "Tamper-evident evidence record you can share",
] as const

export function AuthSplitLayout({
  heading,
  subheading,
  children,
  footer,
}: {
  heading: string
  subheading: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <main className="relative flex min-h-screen">
      {/* Product panel — desktop only */}
      <aside
        className="relative hidden w-[46%] flex-col justify-between overflow-hidden border-r md:flex"
        aria-hidden="true"
      >
        <div className="security-grid pointer-events-none absolute inset-0 opacity-[0.05]" />
        <div className="gradient-hero pointer-events-none absolute inset-0" />
        <div className="relative flex flex-col gap-8 p-10 lg:p-14">
          <div className="gradient-primary shadow-primary-glow flex h-12 w-12 items-center justify-center rounded-xl">
            <ShieldCheck className="text-primary-foreground h-7 w-7" />
          </div>
          <div>
            <p className="text-primary text-xs font-semibold tracking-[0.15em] uppercase">
              LyraShield AI
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-[-0.03em] lg:text-4xl">
              Know what was tested before you ship.
            </h2>
            <p className="text-muted-foreground mt-3 max-w-md text-sm leading-relaxed">
              Release assurance for AI-built apps. LyraShield scans your target, verifies the real
              vulnerabilities, and stages approval-bound fixes — so you ship with evidence, not
              hope.
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            {PROOF_POINTS.map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-sm">
                <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="relative flex items-center gap-4 p-10 text-xs text-muted-foreground lg:p-14">
          <Link href="https://lyrashieldai.com" className="hover:text-foreground transition-colors">
            lyrashieldai.com
          </Link>
          <span aria-hidden="true">·</span>
          <Link
            href="https://lyrashieldai.com/methodology"
            className="hover:text-foreground transition-colors"
          >
            Methodology
          </Link>
          <span aria-hidden="true">·</span>
          <Link
            href="https://lyrashieldai.com/docs/integrations"
            className="hover:text-foreground transition-colors"
          >
            Docs
          </Link>
        </div>
      </aside>

      {/* Form side */}
      <div className="relative flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <div className="gradient-hero pointer-events-none absolute inset-0 md:hidden" aria-hidden="true" />
        <div className="relative w-full max-w-md">
          {/* Mobile-only compact brand mark (panel covers it at md+) */}
          <div className="mb-8 flex flex-col items-center md:hidden">
            <div className="gradient-primary shadow-primary-glow mb-3 flex h-12 w-12 items-center justify-center rounded-xl">
              <ShieldCheck className="text-primary-foreground h-7 w-7" aria-hidden="true" />
            </div>
          </div>
          <div className="mb-8 flex flex-col items-center md:items-start">
            <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{subheading}</p>
          </div>
          {children}
          {footer}
        </div>
      </div>
    </main>
  )
}
