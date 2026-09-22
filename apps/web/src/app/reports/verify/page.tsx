import type { Metadata } from "next"
import { ShieldCheck } from "lucide-react"
import { ReportVerificationForm } from "./report-verification-form"

export const metadata: Metadata = {
  title: "Verify a Launch Readiness Report — LyraShield AI",
  description: "Verify a signed LyraShield Launch Readiness Report and its assessed release.",
  robots: { index: false, follow: false, noarchive: true, noimageindex: true },
  referrer: "no-referrer",
}

export default function ReportVerificationPage() {
  return (
    <main id="main-content" className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-8 flex items-start gap-3">
        <ShieldCheck className="mt-1 h-7 w-7 text-primary" aria-hidden />
        <div>
          <p className="text-sm font-medium text-muted-foreground">LyraShield AI</p>
          <h1 className="text-2xl font-bold tracking-tight">Verify a Launch Readiness Report</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Check that a report was issued by LyraShield and has not been edited. If the owner also
            shared a report link, you can confirm an expected commit or artifact digest without
            exposing the stored release identity.
          </p>
        </div>
      </div>
      <ReportVerificationForm />
    </main>
  )
}
