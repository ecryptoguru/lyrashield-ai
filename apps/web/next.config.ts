import type { NextConfig } from "next"

// Baseline HTTP security headers applied to every response.
// Content-Security-Policy is set per-request in proxy.ts with a nonce
// (see PRD PART B §B13.7 R-A). These are the static security headers.
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
  output: "standalone",
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
