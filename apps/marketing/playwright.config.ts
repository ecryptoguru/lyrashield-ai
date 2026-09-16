import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests-browser",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://127.0.0.1:8787" },
  // The marketing-* specs were migrated from the retired root
  // playwright.marketing.config.ts; that config's webServer relied on
  // `astro dev`, which is broken under the Cloudflare adapter's workerd
  // runner, and nothing invoked it in CI. They keep their desktop+mobile
  // coverage here through the mobile project; the pre-existing *.e2e.ts
  // files stay desktop-only.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testMatch: /marketing-.*\.e2e\.ts$/,
      // iPhone-13-sized viewport + touch, WITHOUT the iPhone device
      // descriptor: Chromium's mobile HTTPS-First behavior (triggered by the
      // mobile UA/isMobile flags) upgrades loopback subresource requests to
      // https://, which `wrangler dev --local` (plain http) cannot serve —
      // the load event never settles.
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
  webServer: {
    command: "pnpm preview",
    url: "http://127.0.0.1:8787/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
