import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Reset your password | LyraShield AI",
  description: "Request a password reset link for your LyraShield account.",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
}

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
