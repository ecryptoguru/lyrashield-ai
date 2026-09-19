import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:3101/e2e/browser/index.html",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs",
    url: "http://127.0.0.1:3101/e2e/browser/index.html",
    reuseExistingServer: !process.env.CI,
  },
})
