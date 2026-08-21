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
      // The standalone Next.js server doesn't load .env, so forward the
      // database URLs that the app needs at runtime. DATABASE_SYSTEM_URL is
      // required for privileged system operations (e.g. license activation's
      // cross-workspace key-hash lookup via getSystemPrisma()). CI sets these
      // explicitly in the workflow; locally they come from .env loaded above.
      `export DATABASE_URL="${process.env.DATABASE_URL ?? ""}" DATABASE_SYSTEM_URL="${process.env.DATABASE_SYSTEM_URL ?? ""}" ` +
      "BETTER_AUTH_URL=http://127.0.0.1:3100 NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 " +
      "NEXT_PUBLIC_MARKETING_URL=https://lyrashieldai.com " +
      "ADDITIONAL_TRUSTED_ORIGINS=http://127.0.0.1:3100 TRUSTED_PROXY_IP_HEADER=x-forwarded-for " +
      "HOSTNAME=127.0.0.1 PORT=3100 NODE_ENV=production LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 " +
      // The e2e suite fires many auth calls (sign-up/sign-in/sign-out) from a
      // small set of simulated client IPs in rapid succession. Raise the
      // in-memory auth rate limit so the suite doesn't trip the 5/min default
      // and produce flaky cross-test interference. Production leaves this unset.
      "RATE_LIMIT_AUTH_MAX=1000 RATE_LIMIT_LICENSE_API_MAX=1000; " +
      // Dev/test-only ed25519 signing key for the e2e license-activation flow.
      // Never used in production (production resolves from Azure Key Vault).
      // Generate a fresh throwaway key at webServer startup and write it to a
      // temp file, then read it into the env var — do NOT commit a private key
      // to the repo (the secret scanner rightly flags embedded PEMs).
      "node -e \"require('node:crypto').generateKeyPairSync('ed25519'); require('node:fs').writeFileSync('/tmp/lyrashield-e2e-lic.pem', require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))\" && " +
      'export LICENSE_SIGNING_PRIVATE_KEY="$(cat /tmp/lyrashield-e2e-lic.pem)" ' +
      // The e2e app runs NODE_ENV=production, so resolveSigningKeyId requires
      // LICENSE_SIGNING_KEY_ID (a test-only key id; production uses a real one).
      "LICENSE_SIGNING_KEY_ID=e2e-license-key-v1; " +
      // Internal API key for license issue/renew routes — required in production
      // (fail-closed when absent). E2E is the internal caller in this test.
      "LYRASHIELD_INTERNAL_API_KEY=e2e-internal-key; " +
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
