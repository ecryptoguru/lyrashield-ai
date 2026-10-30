import { defineConfig, devices } from "@playwright/test"
export default defineConfig({
  testDir: ".",
  testMatch: "v26-dashboard.spec.ts",
  workers: 2,
  use: { baseURL: "http://127.0.0.1:3103/e2e/browser/index.html", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "BROWSER_HARNESS_PORT=3103 node server.mjs",
    url: "http://127.0.0.1:3103/e2e/browser/index.html",
    reuseExistingServer: true,
  },
})
