import { chromium } from "@playwright/test"
import { provisionBillingActors } from "./fixtures"

const baseURL = process.env.LYRASHIELD_E2E_BASE_URL

if (
  process.env.BILLING_STAGING_REGION !== "usd" ||
  process.env.POLAR_ENVIRONMENT !== "sandbox" ||
  !process.env.POLAR_ACCESS_TOKEN ||
  !baseURL
) {
  throw new Error("Polar Sandbox checkout preparation requires isolated USD staging")
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
})
let actors: Awaited<ReturnType<typeof provisionBillingActors>> | undefined

try {
  actors = await provisionBillingActors(browser, baseURL)
  const response = await actors.ownerRequest.post("/billing/checkout", {
    data: { workspaceId: actors.workspaceId, plan: "PRO", interval: "monthly" },
  })
  if (!response.ok()) {
    throw new Error(`Polar Sandbox checkout creation failed: ${response.status()}`)
  }

  const body = (await response.json()) as {
    data?: { provider?: string; url?: string }
  }
  if (body.data?.provider !== "polar" || !body.data.url) {
    throw new Error("Polar Sandbox checkout response is incomplete")
  }
  const checkoutUrl = new URL(body.data.url)
  if (checkoutUrl.protocol !== "https:" || !checkoutUrl.hostname.endsWith("polar.sh")) {
    throw new Error("Polar Sandbox checkout URL is invalid")
  }

  console.log(
    `Polar-checkout-v1 ${Buffer.from(
      JSON.stringify({
        workspaceId: actors.workspaceId,
        checkoutUrl: checkoutUrl.toString(),
        plan: "PRO",
        interval: "monthly",
      })
    ).toString("base64url")}`
  )

  await Promise.all([actors.ownerRequest.dispose(), actors.viewerRequest.dispose()])
  actors = undefined
} finally {
  if (actors) await actors.cleanup()
  await browser.close()
}
