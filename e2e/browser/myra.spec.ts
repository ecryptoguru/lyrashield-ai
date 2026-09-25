import { expect, test } from "@playwright/test"

const proposalStatus = (page: import("@playwright/test").Page) =>
  page.locator("main p[role=status]")

const response = (status: string) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ success: true, data: { status } }),
})

for (const [status, copy] of [
  ["CANCELED", "Canceled before execution."],
  ["EXECUTING", "Already processing"],
  ["COMPLETED", "Done"],
  ["OUTCOME_UNKNOWN", "Checking the outcome"],
] as const) {
  test(`dashboard cancellation shows durable ${status} outcome`, async ({ page }) => {
    await page.route("**/api/myra/proposals/cancel", (route) => route.fulfill(response(status)))
    await page.goto("?myra=proposal")
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(proposalStatus(page)).toContainText(copy)
    await expect(page.getByRole("button", { name: "Confirm action" })).toHaveCount(0)
  })
}

test("dashboard keeps a failed cancellation recoverable", async ({ page }) => {
  await page.route("**/api/myra/proposals/cancel", (route) => route.abort("failed"))
  await page.goto("?myra=proposal")
  const cancel = page.getByRole("button", { name: "Cancel" })
  await cancel.click()
  await expect(proposalStatus(page)).toContainText("Cancellation could not be confirmed")
  await expect(cancel).toBeEnabled()
  await expect(cancel).toBeFocused()
})

test("dashboard does not call an unknown confirmation Done", async ({ page }) => {
  await page.route("**/api/myra/proposals/confirm", (route) =>
    route.fulfill(response("OUTCOME_UNKNOWN"))
  )
  await page.goto("?myra=proposal")
  await page.getByRole("button", { name: "Confirm action" }).click()
  await expect(proposalStatus(page)).toContainText("Checking the outcome")
  await expect(proposalStatus(page)).not.toContainText("Done")
})

for (const [status, copy] of [
  ["CANCELED", "Canceled before execution."],
  ["EXECUTING", "Already processing"],
  ["COMPLETED", "Done"],
  ["OUTCOME_UNKNOWN", "Checking the outcome"],
] as const) {
  test(`marketing cancellation shows durable ${status} outcome`, async ({ page }) => {
    await page.route("**/api/myra/proposals/cancel", (route) => route.fulfill(response(status)))
    await page.goto("?myra=marketing")
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page.locator("section p[role=status]")).toContainText(copy)
    await expect(page.getByRole("button", { name: "Confirm action" })).toBeDisabled()
  })
}

test("marketing keeps a failed cancellation recoverable", async ({ page }) => {
  await page.route("**/api/myra/proposals/cancel", (route) => route.abort("failed"))
  await page.goto("?myra=marketing")
  const cancel = page.getByRole("button", { name: "Cancel" })
  await cancel.click()
  await expect(page.locator("section p[role=status]")).toContainText(
    "Cancellation could not be confirmed"
  )
  await expect(cancel).toBeEnabled()
  await expect(cancel).toBeFocused()
})

test("marketing does not call an unknown confirmation Done", async ({ page }) => {
  await page.route("**/api/myra/proposals/confirm", (route) =>
    route.fulfill(response("OUTCOME_UNKNOWN"))
  )
  await page.goto("?myra=marketing")
  await page.getByRole("button", { name: "Confirm action" }).click()
  await expect(page.locator("section p[role=status]")).toContainText("Checking the outcome")
})

for (const surface of ["proposal", "marketing"] as const) {
  test(`${surface} asks for a fresh preview after an incompatible proposal`, async ({ page }) => {
    await page.route("**/api/myra/proposals/confirm", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "PROPOSAL_PAYLOAD_CHANGED",
            message: "This action preview uses an older format. Ask Myra to prepare it again.",
          },
        }),
      })
    )
    await page.goto(`?myra=${surface}`)
    await page.getByRole("button", { name: "Confirm action" }).click()
    await expect(
      surface === "proposal" ? proposalStatus(page) : page.locator("section p[role=status]")
    ).toContainText("Ask Myra to prepare")
  })
}

test("marketing keeps verification success distinct from a later confirmation failure", async ({
  page,
}) => {
  let confirmations = 0
  await page.route("**/api/myra/proposals/confirm", (route) => {
    confirmations += 1
    if (confirmations === 1) {
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "VERIFICATION_REQUIRED", message: "Verify email" } }),
      })
    }
    return route.abort("failed")
  })
  await page.route("**/api/myra/identity/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  )
  await page.goto("?myra=marketing")
  await page.getByRole("button", { name: "Confirm action" }).click()
  await page
    .getByRole("textbox", { name: "Email for verification code" })
    .fill("owner@example.test")
  await page.getByRole("button", { name: "Email code" }).click()
  await page.getByRole("textbox", { name: "Verification code" }).fill("123456")
  await page.getByRole("button", { name: "Verify & confirm" }).click()
  await expect(page.locator("section p[role=status]")).toContainText(
    "Action outcome could not be confirmed"
  )
})
