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
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  projects: [
    { name: "chromium", testIgnore: /visual|marketing-/, use: { ...devices["Desktop Chrome"] } },
    { name: "visual-mobile", testMatch: /visual\/.*\.spec\.ts/, use: { ...devices["iPhone 13"] } },
    { name: "visual-tablet", testMatch: /visual\/.*\.spec\.ts/, use: { ...devices["iPad Mini"] } },
    {
      name: "visual-desktop",
      testMatch: /visual\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command:
      "export BETTER_AUTH_URL=http://127.0.0.1:3100 NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 " +
      "NEXT_PUBLIC_MARKETING_URL=https://lyrashieldai.com " +
      "ADDITIONAL_TRUSTED_ORIGINS=http://127.0.0.1:3100 TRUSTED_PROXY_IP_HEADER=x-forwarded-for " +
      "HOSTNAME=127.0.0.1 PORT=3100 NODE_ENV=production LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0; " +
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
