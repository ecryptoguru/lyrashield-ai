import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests-browser",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://127.0.0.1:8787" },
  webServer: {
    command: "pnpm preview",
    url: "http://127.0.0.1:8787/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
