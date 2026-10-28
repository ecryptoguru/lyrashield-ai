import { defineConfig, devices } from "@playwright/test"
import base from "./playwright.config"

// Optional local review with the real film; CI continues using its synthetic
// Chromium contracts. Safari engine coverage is not physical-device acceptance.
export default defineConfig({
  ...base,
  projects: [
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"] } },
    {
      name: "webkit-phone",
      use: { browserName: "webkit", viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
})
