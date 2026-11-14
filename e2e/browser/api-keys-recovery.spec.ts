import { expect, test } from "@playwright/test"

const row = {
  id: "key-1",
  name: "Existing key",
  prefix: "fixture-prefix",
  scopes: ["read"],
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
}
const created = {
  ...row,
  id: "key-2",
  name: "New key fixture",
  rawKey: `synthetic-${"a".repeat(80)}`,
}
const failed = {
  status: 500,
  json: { success: false, error: { code: "FAILED", message: "Fixture unavailable" } },
}

for (const width of [390, 1440]) {
  test(`initial key load failure is not an empty list and can be retried at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    let reads = 0
    await page.route("**/api/api-keys**", (route) => {
      reads++
      return route.fulfill(reads === 1 ? failed : { json: { success: true, data: [] } })
    })
    await page.goto("?api-keys")
    await expect(page.getByRole("alert")).toContainText("Fixture unavailable")
    await expect(page.getByText("No API keys yet.")).toHaveCount(0)
    await expect(page.getByText("Loading keys…")).toHaveCount(0)
    const retry = page.getByRole("button", { name: "Retry" })
    await retry.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByText("No API keys yet.")).toBeVisible()
    expect(reads).toBe(2)
  })

  test(`a failed refresh retains the previous keys as stale and recovers at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    let reads = 0
    await page.route("**/api/api-keys**", (route) => {
      if (route.request().method() === "POST")
        return route.fulfill({ json: { success: true, data: created } })
      reads++
      return route.fulfill(
        reads === 2
          ? failed
          : {
              json: {
                success: true,
                data: reads === 1 ? [row] : [row, { ...created, rawKey: undefined }],
              },
            }
      )
    })
    await page.goto("?api-keys")
    await expect(page.getByText("Existing key")).toBeVisible()
    await page.getByRole("button", { name: "New key" }).click()
    await page.getByLabel("Key name").fill("New key fixture")
    await page.getByRole("button", { name: "Create key" }).click()
    await expect(page.getByRole("alert")).toContainText(/out of date/i)
    await expect(page.getByText("Existing key")).toBeVisible()
    await expect(page.getByText("No API keys yet.")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Revoke API key Existing key" })).toBeDisabled()
    await page.getByRole("button", { name: "Retry" }).click()
    await expect(page.getByText("New key fixture", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Revoke API key Existing key" })).toBeEnabled()
  })

  test(`clipboard denial leaves the one-time key fully selectable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
        configurable: true,
      })
      document.execCommand = () => false
    })
    await page.route("**/api/api-keys**", (route) =>
      route.fulfill(
        route.request().method() === "POST"
          ? { json: { success: true, data: created } }
          : { json: { success: true, data: [] } }
      )
    )
    await page.goto("?api-keys")
    await page.getByRole("button", { name: "New key" }).click()
    await page.getByLabel("Key name").fill("New key fixture")
    await page.getByRole("button", { name: "Create key" }).click()
    await page.getByRole("button", { name: "Copy API key" }).click()
    await expect(page.getByRole("alert")).toContainText("Failed to copy")
    const key = page.getByLabel("API key shown once")
    await key.focus()
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe(created.rawKey)
    await expect(page.getByRole("button", { name: "I've stored it safely" })).toBeEnabled()
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.resolve() },
        configurable: true,
      })
    )
    await page.getByRole("button", { name: "Copy API key" }).click()
    await expect(page.getByRole("status")).toContainText("API key copied")
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width)
  })
}

test("copy success is announced without exposing the key in the live region", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    })
  )
  await page.route("**/api/api-keys**", (route) =>
    route.fulfill(
      route.request().method() === "POST"
        ? { json: { success: true, data: created } }
        : { json: { success: true, data: [] } }
    )
  )
  await page.goto("?api-keys")
  await page.getByRole("button", { name: "New key" }).click()
  await page.getByLabel("Key name").fill("New key fixture")
  await page.getByRole("button", { name: "Create key" }).click()
  await page.getByRole("button", { name: "Copy API key" }).click()
  await expect(page.getByRole("status")).toContainText("API key copied")
  await expect(page.getByRole("status")).not.toContainText(created.rawKey)
})

test("old workspace list responses cannot replace the new workspace", async ({ page }) => {
  let releaseOld!: () => void
  const pending = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  await page.route("**/api/api-keys**", async (route) => {
    const workspace = new URL(route.request().url()).searchParams.get("workspaceId")
    if (workspace === "fixture-workspace") await pending
    return route.fulfill({
      json: {
        success: true,
        data: [
          workspace === "fixture-workspace"
            ? row
            : { ...row, id: "other", name: "Other workspace key" },
        ],
      },
    })
  })
  await page.goto("?api-keys&switch-workspace")
  await page.getByRole("button", { name: "Switch workspace" }).click()
  await expect(page.getByText("Other workspace key")).toBeVisible()
  const oldResponse = page.waitForResponse((response) =>
    response.url().includes("workspaceId=fixture-workspace")
  )
  releaseOld()
  await oldResponse
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect(page.getByText("Other workspace key")).toBeVisible()
  await expect(page.getByText("Existing key")).toHaveCount(0)
})

test("a late initial read cannot overwrite a newer post-creation refresh", async ({ page }) => {
  let releaseOld!: () => void
  const pending = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  let reads = 0
  await page.route("**/api/api-keys**", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({ json: { success: true, data: created } })
    reads++
    const initial = reads === 1
    if (initial) await pending
    return route.fulfill({
      json: { success: true, data: initial ? [row] : [{ ...created, rawKey: undefined }] },
    })
  })
  await page.goto("?api-keys")
  await page.getByRole("button", { name: "New key" }).click()
  await page.getByLabel("Key name").fill("New key fixture")
  await page.getByRole("button", { name: "Create key" }).click()
  await expect(page.getByRole("listitem").filter({ hasText: "New key fixture" })).toBeVisible()
  const oldResponse = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().includes("/api/api-keys")
  )
  releaseOld()
  await oldResponse
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect(page.getByText("Existing key")).toHaveCount(0)
  await expect(page.getByRole("listitem").filter({ hasText: "New key fixture" })).toBeVisible()
})

test("failed refresh after revocation retains a disabled stale row until retry", async ({
  page,
}) => {
  let reads = 0
  await page.route("**/api/api-keys**", (route) => {
    if (route.request().method() === "DELETE")
      return route.fulfill({ json: { success: true, data: { id: row.id, revoked: true } } })
    reads++
    return route.fulfill(
      reads === 2
        ? failed
        : {
            json: {
              success: true,
              data: [reads === 1 ? row : { ...row, revokedAt: "2026-11-05T00:00:00.000Z" }],
            },
          }
    )
  })
  await page.goto("?api-keys")
  await page.getByRole("button", { name: "Revoke API key Existing key" }).click()
  await page.getByRole("button", { name: "Confirm revoke" }).click()
  await expect(page.getByRole("alert")).toContainText(/out of date/i)
  await expect(page.getByText("Existing key")).toBeVisible()
  await expect(page.getByRole("button", { name: "Revoke API key Existing key" })).toBeDisabled()
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByRole("listitem").filter({ hasText: "Existing key" })).toContainText(
    "revoked"
  )
  await expect(page.getByRole("button", { name: "Revoke API key Existing key" })).toHaveCount(0)
})

test("a late creation is not shown in another workspace", async ({ page }) => {
  let respond!: () => void
  const pending = new Promise<void>((resolve) => {
    respond = resolve
  })
  await page.route("**/api/api-keys**", async (route) => {
    if (route.request().method() === "POST") {
      await pending
      return route.fulfill({ json: { success: true, data: created } })
    }
    return route.fulfill({ json: { success: true, data: [] } })
  })
  await page.goto("?api-keys&switch-workspace")
  await page.getByRole("button", { name: "New key" }).click()
  await page.getByLabel("Key name").fill("New key fixture")
  await page.getByRole("button", { name: "Create key" }).click()
  await page.getByRole("button", { name: "Switch workspace" }).click()
  const result = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/api/api-keys")
  )
  respond()
  await result
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect(page.getByText(created.rawKey)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "New key" })).toBeEnabled()
  await page.getByRole("button", { name: "Switch workspace" }).click()
  await expect(page.getByText(created.rawKey)).toBeVisible()
})

test("returning to a pending workspace cannot create a second key", async ({ page }) => {
  let respond!: () => void
  const pending = new Promise<void>((resolve) => {
    respond = resolve
  })
  let posts = 0
  await page.route("**/api/api-keys**", async (route) => {
    if (route.request().method() === "POST") {
      posts++
      await pending
      return route.fulfill({ json: { success: true, data: created } })
    }
    return route.fulfill({ json: { success: true, data: [] } })
  })
  await page.goto("?api-keys&switch-workspace")
  await page.getByRole("button", { name: "New key" }).click()
  await page.getByLabel("Key name").fill("New key fixture")
  await page.getByRole("button", { name: "Create key" }).click()
  await page.getByRole("button", { name: "Switch workspace" }).click()
  await page.getByRole("button", { name: "Switch workspace" }).click()
  await page.getByRole("button", { name: "New key" }).click()
  await page.getByLabel("Key name").fill("Another draft")
  await expect(page.getByRole("button", { name: "Create key" })).toBeDisabled()
  expect(posts).toBe(1)
  respond()
  await expect(page.getByText(created.rawKey)).toBeVisible()
  await expect(page.getByLabel("Key name")).toHaveValue("Another draft")
  expect(posts).toBe(1)
})

test("expiry labels distinguish past, future, absent and invalid values and update while open", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-05T00:00:00.000Z") })
  await page.route("**/api/api-keys**", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          { ...row, id: "none", name: "No expiry key" },
          { ...row, id: "past", name: "Past key", expiresAt: "2026-11-04T00:00:00.000Z" },
          { ...row, id: "future", name: "Future key", expiresAt: "2026-11-05T00:00:10.000Z" },
          { ...row, id: "invalid", name: "Invalid key", expiresAt: "unknown" },
        ],
      },
    })
  )
  await page.goto("?api-keys")
  await expect(page.getByRole("listitem").filter({ hasText: "No expiry key" })).toContainText(
    /no expiry/i
  )
  await expect(page.getByRole("listitem").filter({ hasText: "Past key" })).toContainText(/expired/i)
  await expect(page.getByRole("listitem").filter({ hasText: "Future key" })).toContainText(
    /expires/i
  )
  await expect(page.getByRole("listitem").filter({ hasText: "Invalid key" })).toContainText(
    /expiry unavailable/i
  )
  await page.clock.fastForward(10_100)
  await expect(page.getByRole("listitem").filter({ hasText: "Future key" })).toContainText(
    /expired/i
  )
})
