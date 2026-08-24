import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Authorize integration | LyraShield AI",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
}

export default function OAuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
