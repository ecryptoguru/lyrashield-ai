/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@lyrashield/db",
    "@lyrashield/auth",
    "@lyrashield/ui",
    "@lyrashield/types",
    "@lyrashield/logger",
    "@lyrashield/integrations",
  ],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "@prisma/client-runtime-utils"],
}

export default nextConfig
