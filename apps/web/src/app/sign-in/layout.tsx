import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Sign in | LyraShield AI",
  description: "Sign in to your LyraShield account.",
}

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
