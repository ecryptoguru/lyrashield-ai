import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests-browser",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://127.0.0.1:4322" },
  webServer: {
    command:
      "ASTRO_DEV_BACKGROUND=0 pnpm exec astro dev --ignore-lock --host 127.0.0.1 --port 4322",
    url: "http://127.0.0.1:4322/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
