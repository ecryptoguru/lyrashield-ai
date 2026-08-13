import { defineConfig, devices } from "@playwright/test"

const configuredPort = Number(process.env.PLAYWRIGHT_MARKETING_PORT ?? "4321")
if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) {
  throw new Error("PLAYWRIGHT_MARKETING_PORT must be an unprivileged TCP port")
}
const marketingBaseUrl = `http://127.0.0.1:${configuredPort}`

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: marketingBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  projects: [
    {
      name: "marketing-chromium",
      testMatch: /marketing-.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "marketing-mobile",
      testMatch: /marketing-.*\.spec\.ts$/,
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: {
    command: `ASTRO_DEV_BACKGROUND=0 pnpm --filter @lyrashield/marketing dev --host 127.0.0.1 --port ${configuredPort}`,
    url: `${marketingBaseUrl}/tools`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
