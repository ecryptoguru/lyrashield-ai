import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import { headers } from "next/headers"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PostHogProvider } from "@/components/posthog-provider"
import { BrowserErrorMonitorGate } from "@/components/browser-error-monitor"
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
})

export const metadata: Metadata = {
  title: "LyraShield AI — Release assurance for AI-built apps",
  // Bounded product description: findings carry evidence states and fixes are
  // review-gated proposals — never claim verified vulnerabilities here.
  description:
    "Connect a GitHub repo or paste an app URL. LyraShield records findings with evidence states, prepares review-gated fix proposals and produces a release report.",
  // The app host is do-not-index (robots.txt disallows all). A root default
  // keeps routes without their own robots field — like /buy/local — out of
  // search indexes; stronger per-route policies (noimageindex, no-referrer)
  // still override this where they are declared.
  robots: { index: false, follow: false, noarchive: true },
  openGraph: {
    title: "LyraShield AI — Release assurance for AI-built apps",
    description:
      "Connect a GitHub repo or paste an app URL. LyraShield records findings with evidence states, prepares review-gated fix proposals and produces a release report.",
    type: "website",
    siteName: "LyraShield AI",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Reading headers() forces dynamic rendering so the per-request nonce
  // from proxy.ts is available to Next.js internal script tags.
  const requestHeaders = await headers()
  const nonce = requestHeaders.get("x-nonce") ?? undefined

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              "(()=>{try{const c=document.cookie.match(/(?:^|; )lyrashield-theme=(system|light|dark)(?:;|$)/)?.[1];const s=localStorage.getItem('lyrashield-theme');const t=c||s||'system';const d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=d?'dark':'light'}catch{}})()",
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <TooltipProvider>
            <BrowserErrorMonitorGate />
            <PostHogProvider>{children}</PostHogProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
