import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Retrieve your license | LyraShield AI",
  description: "Securely retrieve your LyraShield Local license.",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
}

export default function LicenseRetrievalLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
