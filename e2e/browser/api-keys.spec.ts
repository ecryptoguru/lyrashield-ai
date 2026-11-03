import { expect, test } from "@playwright/test"

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`${name}: cancel and a failed creation preserve keyboard focus and the draft`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.route("**/api/api-keys**", (route) =>
      route.fulfill(
        route.request().method() === "GET"
          ? { json: { success: true, data: [] } }
          : {
              status: 500,
              json: { success: false, error: { code: "FAILED", message: "Fixture unavailable" } },
            }
      )
    )
    await page.goto("?api-keys")
    const trigger = page.getByRole("button", { name: "New key" })
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("radio", { name: /Read-only/ })).toBeChecked()
    await expect(page.getByLabel("Expires after")).toHaveValue("0")
    const cancel = page.getByRole("button", { name: "Cancel" })
    await cancel.focus()
    await page.keyboard.press("Enter")
    await expect(trigger).toBeFocused()

    await page.keyboard.press("Enter")
    const nameInput = page.getByLabel("Key name")
    await nameInput.fill("Fixture draft")
    await page.getByLabel("Expires after").selectOption("4")
    await page.getByRole("radio", { name: /Read & write/ }).check()
    await page.getByRole("button", { name: "Create key" }).focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("alert")).toContainText("Fixture unavailable")
    await expect(nameInput).toBeFocused()
    await expect(nameInput).toHaveValue("Fixture draft")
    await expect(page.getByLabel("Expires after")).toHaveValue("4")
    await expect(page.getByRole("radio", { name: /Read & write/ })).toBeChecked()
  })
}

test("failed creation does not steal focus moved while the request is pending", async ({
  page,
}) => {
  let respond!: () => void
  const pending = new Promise<void>((resolve) => {
    respond = resolve
  })
  await page.route("**/api/api-keys**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { success: true, data: [] } })
    await pending
    await route.fulfill({
      status: 500,
      json: { success: false, error: { code: "FAILED", message: "Fixture unavailable" } },
    })
  })
  await page.goto("?api-keys")
  await page.getByRole("button", { name: "New key" }).click()
  await page.getByLabel("Key name").fill("Fixture draft")
  await page.getByRole("button", { name: "Create key" }).focus()
  await page.keyboard.press("Enter")
  const cancel = page.getByRole("button", { name: "Cancel" })
  await cancel.focus()
  respond()
  await expect(page.getByRole("alert")).toContainText("Fixture unavailable")
  await expect(cancel).toBeFocused()
})

test("failed creation returns focus to the retained name when the submit button was focused", async ({
  page,
}) => {
  await page.route("**/api/api-keys**", (route) =>
    route.fulfill(
      route.request().method() === "GET"
        ? { json: { success: true, data: [] } }
        : {
            status: 500,
            json: { success: false, error: { code: "FAILED", message: "Fixture unavailable" } },
          }
    )
  )
  await page.goto("?api-keys")
  await page.getByRole("button", { name: "New key" }).click()
  const nameInput = page.getByLabel("Key name")
  await nameInput.fill("Fixture draft")
  await page.getByRole("button", { name: "Create key" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("alert")).toContainText("Fixture unavailable")
  await expect(nameInput).toBeFocused()
})

test("late failure after cancel and reopen does not move focus into the new form", async ({
  page,
}) => {
  let respond!: () => void
  const pending = new Promise<void>((resolve) => {
    respond = resolve
  })
  await page.route("**/api/api-keys**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { success: true, data: [] } })
    await pending
    await route.fulfill({
      status: 500,
      json: { success: false, error: { code: "FAILED", message: "Fixture unavailable" } },
    })
  })
  await page.goto("?api-keys")
  const trigger = page.getByRole("button", { name: "New key" })
  await trigger.click()
  await page.getByLabel("Key name").fill("Original draft")
  await page.getByRole("button", { name: "Create key" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Cancel" }).click()
  await trigger.click()
  const readOnly = page.getByRole("radio", { name: /Read-only/ })
  await readOnly.focus()
  respond()
  await expect(page.getByRole("alert")).toContainText("Fixture unavailable")
  await expect(readOnly).toBeFocused()
  await expect(page.getByLabel("Key name")).toHaveValue("")
})

test("IME composition in the key name does not submit or close the form", async ({ page }) => {
  let posts = 0
  await page.route("**/api/api-keys**", (route) => {
    if (route.request().method() === "POST") posts++
    return route.fulfill({ json: { success: true, data: [] } })
  })
  await page.goto("?api-keys")
  await page.getByRole("button", { name: "New key" }).click()
  const input = page.getByLabel("Key name")
  await input.focus()
  await input.dispatchEvent("compositionstart", { data: "" })
  await input.fill("日本語")
  await page.keyboard.press("Enter")
  await input.dispatchEvent("compositionend", { data: "日本語" })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("日本語")
  expect(posts).toBe(0)
})
