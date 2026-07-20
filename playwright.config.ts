import { defineConfig, devices } from "@playwright/test"
import { existsSync } from "node:fs"

if (existsSync(".env")) process.loadEnvFile(".env")

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "export BETTER_AUTH_URL=http://127.0.0.1:3100 NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 " +
      "ADDITIONAL_TRUSTED_ORIGINS=http://127.0.0.1:3100 TRUSTED_PROXY_IP_HEADER=x-forwarded-for " +
      "LYRASHIELD_BETA_INVITE_EMAILS=e2e-owner@example.com,e2e-other@example.com " +
      "HOSTNAME=127.0.0.1 PORT=3100 NODE_ENV=production; " +
      (process.env.CI ? "" : "pnpm --filter @lyrashield/web build && ") +
      "rm -rf apps/web/.next/standalone/apps/web/.next/static apps/web/.next/standalone/apps/web/public && " +
      "cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static && " +
      "([ ! -d apps/web/public ] || cp -R apps/web/public apps/web/.next/standalone/apps/web/public) && " +
      "node apps/web/.next/standalone/apps/web/server.js",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
