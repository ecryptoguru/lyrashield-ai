import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { isSafeDisposableDatabaseUrl } from "../../packages/config/src/auth-test-mail"
import { isOwnedAuthTestMailDirectory } from "../../packages/auth/src/auth-test-mail-directory"

// This suite starts its own development server. Never reuse a production-mode app.
const baseURL = "http://127.0.0.1:3102"
if (process.env.DEBUG || process.env.PWDEBUG || process.env.PW_TEST_DEBUG) {
  throw new Error("Auth mail browser proof must run without debug logging")
}
if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") {
  throw new Error("Auth mail browser proof requires an explicit disposable database")
}
for (const name of ["DATABASE_URL", "DATABASE_SYSTEM_URL"]) {
  const value = process.env[name]
  if (!isSafeDisposableDatabaseUrl(value)) {
    throw new Error("Auth mail browser proof requires named loopback test databases")
  }
}
process.env.BETTER_AUTH_URL = baseURL
process.env.NEXT_PUBLIC_APP_URL = baseURL
process.env.BREVO_API_KEY = ""
// Failed-test page snapshots can retain bearer links even with tracing disabled.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"
const authMailDirectory = process.env.LYRASHIELD_TEST_AUTH_MAIL_DIR
const ownedAuthMailDirectory = process.env.LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR
if (
  !authMailDirectory ||
  !ownedAuthMailDirectory ||
  !isOwnedAuthTestMailDirectory(authMailDirectory, ownedAuthMailDirectory)
) {
  throw new Error("Run the auth mail browser proof through its private fixture runner")
}

export default defineConfig({
  testDir: ".",
  testMatch: "password-reset.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  globalTeardown: "./teardown.ts",
  use: {
    baseURL,
    // Bearer reset links are fixture-only and must not enter retained browser artifacts.
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    command:
      "node apps/web/node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 3102",
    env: {
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      BETTER_AUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      ADDITIONAL_TRUSTED_ORIGINS: baseURL,
      BREVO_API_KEY: "",
      // Explicitly forward the validated fixture target and its safety marker
      // to the separately spawned Next process.
      DATABASE_URL: process.env.DATABASE_URL!,
      DATABASE_SYSTEM_URL: process.env.DATABASE_SYSTEM_URL!,
      LYRASHIELD_TEST_DB_DISPOSABLE: "1",
      LYRASHIELD_REQUIRE_EMAIL_VERIFICATION: "0",
      LYRASHIELD_TEST_AUTH_MAIL_DIR: authMailDirectory,
      LYRASHIELD_TEST_AUTH_MAIL_OWNED_DIR: ownedAuthMailDirectory,
      RATE_LIMIT_AUTH_MAX: "1000",
      RATE_LIMIT_API_MAX: "1000",
      NEXT_PUBLIC_POSTHOG_KEY: "",
    },
    url: `${baseURL}/api/auth/get-session`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
