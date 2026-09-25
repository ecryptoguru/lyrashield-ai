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
  await page.getByRole("textbox", { name: "Verification code", exact: true }).fill("123456")
  await page.getByRole("button", { name: "Verify & confirm" }).click()
  await expect(page.locator("section p[role=status]")).toContainText(
    "Action outcome could not be confirmed"
  )
})

test("dashboard keeps the second turn active when a stopped stream settles late", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("?myra=proposal")
  await page.evaluate(() => {
    const state = window as Window & { myraStreams?: ReadableStreamDefaultController<Uint8Array>[] }
    state.myraStreams = []
    window.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/myra/message")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            state.myraStreams!.push(controller)
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"ready","conversationId":"c","traceId":"t"}\n\n'
              )
            )
          },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({ suggestions: [] })
    }) as typeof fetch
  })
  const composer = page.getByRole("textbox", { name: "Myra message" })
  await composer.fill("first")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByTestId("streaming")).toHaveText("true")
  await page.getByRole("button", { name: "Stop message" }).click()
  await composer.fill("second")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByTestId("streaming")).toHaveText("true")
  await page.evaluate(() => {
    ;(
      window as Window & { myraStreams?: ReadableStreamDefaultController<Uint8Array>[] }
    ).myraStreams![0]!.close()
  })
  await expect(page.getByTestId("streaming")).toHaveText("true")
  await page.getByRole("button", { name: "Stop message" }).click()
  await expect(page.getByTestId("streaming")).toHaveText("false")
})

test("dashboard explains a token-only stream interruption", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route("**/api/myra/message", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'data: {"type":"ready","conversationId":"c","traceId":"t"}\n\ndata: {"type":"token","text":"partial"}\n\n',
    })
  )
  await page.goto("?myra=proposal")
  await page.getByRole("textbox", { name: "Myra message" }).fill("hello")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByRole("log")).toContainText("partial")
  await expect(page.getByRole("alert")).toContainText("response ended early")
})
