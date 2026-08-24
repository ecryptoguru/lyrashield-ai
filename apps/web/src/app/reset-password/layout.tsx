import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Choose a new password | LyraShield AI",
  description: "Set a new password for your LyraShield account.",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
}

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
