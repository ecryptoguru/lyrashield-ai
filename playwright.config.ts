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
      "HOSTNAME=127.0.0.1 PORT=3100 NODE_ENV=production LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 " +
      // The e2e suite fires many auth calls (sign-up/sign-in/sign-out) from a
      // small set of simulated client IPs in rapid succession. Raise the
      // in-memory auth rate limit so the suite doesn't trip the 5/min default
      // and produce flaky cross-test interference. Production leaves this unset.
      "RATE_LIMIT_AUTH_MAX=1000; " +
      // Dev/test-only ed25519 signing key for the e2e license-activation flow.
      // Never used in production (production resolves from Azure Key Vault).
      // Write the PEM to a temp file then read it into the env var — embedding a
      // multi-line PEM directly in the command string is too fragile across the
      // TS-string -> shell quoting layers and produced a malformed key.
      "printf '%s\\n' '-----BEGIN PRIVATE KEY-----' 'MC4CAQAwBQYDK2VwBCIEIM3vjBHfDGv/9UqGuK8KQihi9mQBKjD+Y0HHbxLinhoP' '-----END PRIVATE KEY-----' > /tmp/lyrashield-e2e-lic.pem && " +
      'export LICENSE_SIGNING_PRIVATE_KEY="$(cat /tmp/lyrashield-e2e-lic.pem)" ' +
      // The e2e app runs NODE_ENV=production, so resolveSigningKeyId requires
      // LICENSE_SIGNING_KEY_ID (a test-only key id; production uses a real one).
      "LICENSE_SIGNING_KEY_ID=e2e-license-key-v1; " +
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
