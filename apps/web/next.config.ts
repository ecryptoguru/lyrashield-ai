import type { NextConfig } from "next"

// Baseline HTTP security headers applied to every response.
// NOTE: a full Content-Security-Policy is intentionally NOT set here yet — a
// strict CSP for the Next.js App Router needs per-request nonces (middleware)
// and must be validated against the real app, so it's a dedicated follow-up
// (see PRD PART B §B13.7 R-A). These headers are the safe, high-value subset.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    "@lyrashield/db",
    "@lyrashield/auth",
    "@lyrashield/ui",
    "@lyrashield/types",
    "@lyrashield/logger",
    "@lyrashield/integrations",
  ],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "@prisma/client-runtime-utils"],
  images: {
    // Allowlist only the OAuth avatar hosts we actually render (GitHub, Google).
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
