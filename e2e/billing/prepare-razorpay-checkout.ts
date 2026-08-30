import { chromium } from "@playwright/test"
import { provisionBillingActors } from "./fixtures"

const baseURL = process.env.LYRASHIELD_E2E_BASE_URL

if (
  process.env.BILLING_STAGING_REGION !== "inr" ||
  !process.env.RAZORPAY_KEY_ID?.startsWith("rzp_test_") ||
  !baseURL
) {
  throw new Error("Razorpay Test checkout preparation requires isolated INR staging")
}

const browser = await chromium.launch({ headless: true })
let actors: Awaited<ReturnType<typeof provisionBillingActors>> | undefined

try {
  actors = await provisionBillingActors(browser, baseURL)
  const response = await actors.ownerRequest.post("/billing/checkout", {
    data: { workspaceId: actors.workspaceId, plan: "PRO", interval: "monthly" },
  })
  if (!response.ok()) {
    throw new Error(`Razorpay Test checkout creation failed: ${response.status()}`)
  }

  const body = (await response.json()) as {
    data?: { provider?: string; subscriptionId?: string; keyId?: string }
  }
  if (
    body.data?.provider !== "razorpay" ||
    !body.data.subscriptionId ||
    !body.data.keyId?.startsWith("rzp_test_")
  ) {
    throw new Error("Razorpay Test checkout response is incomplete")
  }

  console.log(
    `Razorpay-checkout-v1 ${Buffer.from(
      JSON.stringify({
        workspaceId: actors.workspaceId,
        subscriptionId: body.data.subscriptionId,
        keyId: body.data.keyId,
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
