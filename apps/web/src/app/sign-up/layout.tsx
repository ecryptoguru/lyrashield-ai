import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Sign up | LyraShield AI",
  description: "Create your LyraShield account and start your evidence-backed release workflow.",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
}

export default function SignUpLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
