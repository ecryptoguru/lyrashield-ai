import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { headers } from "next/headers"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
})

export const metadata: Metadata = {
  title: "LyraShield — AI AppSec Agent Platform",
  description:
    "Connect a GitHub repo or paste an app URL. LyraShield safely scans it, verifies real vulnerabilities, explains the risk, and helps create fix PRs.",
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
              "(()=>{try{const t=localStorage.getItem('lyrashield-theme')||'system';const d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=d?'dark':'light'}catch{}})()",
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
