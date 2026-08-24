import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Two-factor verification | LyraShield AI",
  description: "Complete two-factor verification to access your LyraShield account.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default function TwoFactorLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
