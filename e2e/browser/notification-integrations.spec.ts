import { expect, test } from "@playwright/test"

const activeSlack = {
  id: "integration-slack",
  channel: "slack",
  name: "Slack notifications",
  status: "active",
  updatedAt: "2026-10-09T00:00:00.000Z",
}
const slackWebhook = "https://hooks.slack.com/services/TEXAMPLE/BEXAMPLE/example-token"

test("saving a masked webhook never sends a message until the explicit test, and disconnect is recoverable", async ({
  page,
}) => {
  const calls: Array<{ method: string; body: unknown }> = []
  let configured = false
  await page.route("**/api/integrations/notifications**", async (route) => {
    const request = route.request()
    if (request.method() === "GET") {
      await route.fulfill({ json: { success: true, data: [] } })
      return
    }
    calls.push({ method: request.method(), body: request.postDataJSON() })
    if (request.url().endsWith("/test")) {
      await route.fulfill({ json: { success: true, data: { sent: true } } })
      return
    }
    configured = request.method() === "POST"
    await route.fulfill({
      json: { success: true, data: { ...activeSlack, status: configured ? "active" : "disabled" } },
    })
  })
  await page.goto("?notification-integrations")
  const slack = page.getByRole("region", { name: "Slack notifications" })
  await expect(slack.getByText("Not connected", { exact: true })).toBeVisible()
  const input = slack.getByLabel("Slack webhook URL")
  await expect(input).toHaveAttribute("type", "password")
  await input.fill(slackWebhook)
  await slack.getByRole("button", { name: "Connect Slack", exact: true }).click()
  await expect(slack.getByText("Connected", { exact: true })).toBeVisible()
  expect(calls).toEqual([
    {
      method: "POST",
      body: { workspaceId: "workspace-test", channel: "slack", webhookUrl: slackWebhook },
    },
  ])
  await expect(slack.getByLabel("Slack webhook URL")).toHaveCount(0)
  await expect(page.getByText(slackWebhook)).toHaveCount(0)
  await slack.getByRole("button", { name: "Send test", exact: true }).click()
  await expect(slack.getByRole("status")).toContainText("Test message sent")
  expect(calls[1]).toEqual({
    method: "POST",
    body: { workspaceId: "workspace-test", channel: "slack" },
  })
  await slack.getByRole("button", { name: "Disconnect", exact: true }).click()
  await slack.getByRole("button", { name: "Keep connected", exact: true }).click()
  expect(calls).toHaveLength(2)
  await slack.getByRole("button", { name: "Disconnect", exact: true }).click()
  await slack.getByRole("button", { name: "Confirm disconnect", exact: true }).click()
  await expect(slack.getByText("Disconnected", { exact: true })).toBeVisible()
  await expect(slack.getByRole("button", { name: "Connect Slack", exact: true })).toBeVisible()
  expect(configured).toBe(false)
  expect(calls[2]).toEqual({
    method: "DELETE",
    body: { workspaceId: "workspace-test", channel: "slack" },
  })
})

test("non-admin members can see channel status without credential or mutation controls", async ({
  page,
}) => {
  await page.route("**/api/integrations/notifications?*", (route) =>
    route.fulfill({ json: { success: true, data: [activeSlack] } })
  )
  await page.goto("?notification-integrations&read-only")
  await expect(
    page
      .getByRole("region", { name: "Slack notifications" })
      .getByText("Connected", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Only workspace owners and admins can manage these channels.")
  ).toBeVisible()
  await expect(page.getByLabel(/webhook URL/)).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: /Connect Slack|Send test|Disconnect|Update webhook/ })
  ).toHaveCount(0)
})

test("load failures provide a retry without presenting an unknown channel as disconnected", async ({
  page,
}) => {
  let fail = true
  await page.route("**/api/integrations/notifications?*", (route) =>
    route.fulfill({
      status: fail ? 500 : 200,
      json: fail
        ? { success: false, error: { code: "ERROR", message: "Unavailable" } }
        : { success: true, data: [] },
    })
  )
  await page.goto("?notification-integrations")
  await expect(page.getByRole("alert")).toContainText("Unable to load notification channels")
  await expect(page.getByLabel(/webhook URL/)).toHaveCount(0)
  fail = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByLabel("Discord webhook URL")).toBeVisible()
})

test("mutation failures retain the connected state and never echo credentials from an error", async ({
  page,
}) => {
  await page.route("**/api/integrations/notifications**", (route) =>
    route.fulfill({
      status: route.request().method() === "GET" ? 200 : 502,
      json:
        route.request().method() === "GET"
          ? { success: true, data: [activeSlack] }
          : { success: false, error: { code: "ERROR", message: slackWebhook } },
    })
  )
  await page.goto("?notification-integrations")
  const slack = page.getByRole("region", { name: "Slack notifications" })
  await slack.getByRole("button", { name: "Send test", exact: true }).click()
  await expect(slack.getByRole("alert")).toContainText("Unable to send the test message")
  await expect(slack.getByText("Connected", { exact: true })).toBeVisible()
  await slack.getByRole("button", { name: "Update webhook", exact: true }).click()
  await slack.getByLabel("Slack webhook URL").fill(slackWebhook)
  await slack.getByRole("button", { name: "Save webhook", exact: true }).click()
  await expect(slack.getByRole("alert")).toContainText("Unable to save the webhook")
  await expect(page.getByText(slackWebhook)).toHaveCount(0)
  await slack.getByRole("button", { name: "Cancel", exact: true }).click()
  await slack.getByRole("button", { name: "Disconnect", exact: true }).click()
  await slack.getByRole("button", { name: "Confirm disconnect", exact: true }).click()
  await expect(slack.getByRole("alert")).toContainText("Unable to disconnect")
  await expect(slack.getByText("Connected", { exact: true })).toBeVisible()
})

test("workspace switching clears draft credentials and ignores late summaries", async ({
  page,
}) => {
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/integrations/notifications?*", async (route) => {
    if (route.request().url().includes("workspace-test")) await pending
    await route.fulfill({
      json: {
        success: true,
        data: route.request().url().includes("workspace-test") ? [activeSlack] : [],
      },
    })
  })
  await page.goto("?notification-integrations")
  await expect(page.getByRole("status")).toContainText("Loading notification channels")
  await page.getByRole("button", { name: "Switch workspace" }).click()
  const slack = page.getByRole("region", { name: "Slack notifications" })
  await expect(slack.getByText("Not connected", { exact: true })).toBeVisible()
  release?.()
  await expect(slack.getByText("Connected", { exact: true })).toHaveCount(0)
  await expect(slack.getByLabel("Slack webhook URL")).toHaveValue("")
})

test("a pending Discord save is submitted once and cannot overwrite a switched workspace", async ({
  page,
}) => {
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: unknown[] = []
  await page.route("**/api/integrations/notifications**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { success: true, data: [] } })
      return
    }
    calls.push(route.request().postDataJSON())
    await pending
    await route.fulfill({
      json: {
        success: true,
        data: { ...activeSlack, channel: "discord", id: "integration-discord" },
      },
    })
  })
  await page.goto("?notification-integrations")
  const discord = page.getByRole("region", { name: "Discord notifications" })
  const webhookUrl = "https://discord.com/api/webhooks/123456789012345678/example-token"
  await discord.getByLabel("Discord webhook URL").fill(webhookUrl)
  await discord.locator("form").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
  await expect(discord.getByRole("button", { name: "Saving…" })).toBeDisabled()
  expect(calls).toEqual([{ workspaceId: "workspace-test", channel: "discord", webhookUrl }])
  await page.getByRole("button", { name: "Switch workspace" }).click()
  await expect(discord.getByLabel("Discord webhook URL")).toHaveValue("")
  release?.()
  await expect(discord.getByText("Connected", { exact: true })).toHaveCount(0)
  await expect(discord.getByText("Not connected", { exact: true })).toBeVisible()
})

for (const theme of ["light", "dark"]) {
  for (const width of [320, 1440]) {
    test(`notification channels reflow at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.route("**/api/integrations/notifications?*", (route) =>
        route.fulfill({ json: { success: true, data: [activeSlack] } })
      )
      await page.goto(`?notification-integrations&theme=${theme}`)
      await expect(page.getByLabel("Discord webhook URL")).toBeVisible()
      for (const button of await page.getByRole("button").all()) {
        const bounds = await button.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        expect(bounds!.height).toBeGreaterThanOrEqual(44)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )
    })
  }
}
