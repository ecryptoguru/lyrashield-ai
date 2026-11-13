import { test, expect } from "@playwright/test"

const repo = (id: number) => ({
  id,
  fullName: `example/repo-${id}`,
  name: `repo-${id}`,
  owner: "example",
  defaultBranch: "main",
  private: false,
  htmlUrl: `https://github.com/example/repo-${id}`,
  installationId: "42",
})

test("repository picker pages, searches loaded results and adds another target", async ({
  page,
}) => {
  const requests: string[] = []
  await page.route("**/api/integrations/github/repos?**", (route) => {
    requests.push(route.request().url())
    const second = new URL(route.request().url()).searchParams.get("page") === "2"
    return route.fulfill({
      json: {
        success: true,
        data: {
          items: second ? [repo(51)] : Array.from({ length: 50 }, (_, i) => repo(i + 1)),
          nextPage: second ? null : 2,
        },
      },
    })
  })
  let created = 0
  await page.route("**/api/targets", (route) => {
    created++
    return route.fulfill({ json: { success: true, data: { id: `target-${created}` } } })
  })
  await page.goto("?v26-dashboard=github")
  await page.getByRole("button", { name: "Load repositories", exact: true }).click()
  await expect(page.getByRole("button", { name: "example/repo-1", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Load more repositories" }).click()
  await page.getByRole("textbox", { name: "Search loaded repositories" }).fill("repo-51")
  await page.getByRole("button", { name: "example/repo-51", exact: true }).click()
  await page.getByRole("button", { name: "Add “example/repo-51” as target" }).click()
  await expect(page.getByRole("status")).toContainText("Target created successfully")
  await page.getByRole("button", { name: "Add another repository" }).click()
  await page.getByRole("textbox", { name: "Search loaded repositories" }).fill("repo-1")
  await page.getByRole("button", { name: "example/repo-1", exact: true }).click()
  await page.getByRole("button", { name: "Add “example/repo-1” as target" }).click()
  expect(created).toBe(2)
  expect(requests.map((url) => new URL(url).searchParams.get("page"))).toEqual(["1", "2"])
})

test("failed notification load shows retry without the empty-state claim", async ({ page }) => {
  await page.route("**/api/notifications?**", (route) =>
    route.fulfill({ status: 503, json: { success: false, error: { message: "Unavailable" } } })
  )
  await page.goto("?v26-dashboard=notifications")
  await expect(page.getByText("Failed to load notifications.")).toBeVisible()
  await expect(page.getByText("No notifications", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
})

test("minute pack checkout blocks repeated clicks across pending redirect and retries on actual error", async ({
  page,
}) => {
  let calls = 0
  await page.route("**/api/billing/topup", async (route) => {
    calls++
    return route.fulfill({
      status: calls === 1 ? 503 : 200,
      json:
        calls === 1
          ? { success: false, error: { message: "Try checkout again" } }
          : { success: true, data: { url: `${page.url()}#checkout` } },
    })
  })
  await page.goto("?v26-dashboard=pack")
  await page.getByRole("button", { name: "Buy Minute Pack" }).click()
  await expect(page.getByRole("alert")).toContainText("Try checkout again")
  await page.getByRole("button", { name: "Buy Minute Pack" }).click()
  await expect(page.getByRole("button", { name: "Opening secure checkout…" })).toBeDisabled()
  expect(calls).toBe(2)
})

for (const width of [390, 1280])
  test(`disabled preferences remain honest at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("?v26-dashboard=preferences")
    await expect(
      page.getByText("Personal email and in-app preferences are not available yet.", {
        exact: false,
      })
    ).toBeVisible()
    await expect(page.getByRole("switch")).toHaveCount(3)
    for (const control of await page.getByRole("switch").all()) await expect(control).toBeDisabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
  })

test("target creation searches only paged loaded repositories and clears the last selection", async ({
  page,
}) => {
  const pages: string[] = []
  await page.route("**/api/integrations/github/repos?**", (route) => {
    const next = new URL(route.request().url()).searchParams.get("page") ?? "missing"
    pages.push(next)
    return route.fulfill({
      json: {
        success: true,
        data: { items: next === "1" ? [repo(1)] : [repo(2)], nextPage: next === "1" ? 2 : null },
      },
    })
  })
  await page.route("**/api/targets", (route) =>
    route.fulfill({ json: { success: true, data: { id: "target-new", name: "example/repo-2" } } })
  )
  await page.route("**/api/targets?**", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  await page.goto("?v26-dashboard=targets&add=1")
  await expect(page.getByLabel("Select repository")).toContainText("example/repo-1")
  await page.getByRole("button", { name: "Load more repositories" }).click()
  await page.getByRole("textbox", { name: "Search loaded repositories" }).fill("repo-2")
  await expect(page.getByLabel("Select repository")).not.toContainText("example/repo-1")
  await page.getByLabel("Select repository").selectOption("2")
  await page.getByLabel("Select repository").selectOption("")
  await expect(page.getByRole("button", { name: /^Create target$/i })).toBeDisabled()
  await page.getByLabel("Select repository").selectOption("2")
  await page.getByRole("button", { name: /^Create target$/i, exact: true }).click()
  await expect(page.getByRole("status")).toContainText("ready for scan setup")
  expect(pages).toEqual(["1", "2"])
})

test("repository load-more failure retains loaded choices and permits retry", async ({ page }) => {
  let secondAttempts = 0
  await page.route("**/api/integrations/github/repos?**", (route) => {
    const next = new URL(route.request().url()).searchParams.get("page")
    if (next === "2" && ++secondAttempts === 1)
      return route.fulfill({
        status: 503,
        json: { success: false, error: { code: "UNAVAILABLE", message: "Try loading again" } },
      })
    return route.fulfill({
      json: {
        success: true,
        data: { items: next === "1" ? [repo(1)] : [repo(2)], nextPage: next === "1" ? 2 : null },
      },
    })
  })
  await page.goto("?v26-dashboard=github")
  await page.getByRole("button", { name: "Load repositories", exact: true }).click()
  await page.getByRole("button", { name: "Load more repositories" }).click()
  await expect(page.getByRole("alert")).toContainText("Try loading again")
  await expect(page.getByRole("button", { name: "example/repo-1", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Load more repositories" }).click()
  await expect(page.getByRole("button", { name: "example/repo-2", exact: true })).toBeVisible()
})

for (const width of [390, 1280])
  test(`capacity receipt separates elapsed and charged time at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("?v26-dashboard=capacity")
    await expect(page.getByRole("status")).toContainText("6 agent-minutes charged")
    await expect(page.getByRole("status")).toContainText("Elapsed analysis: 1m 1s")
    await expect(page.getByRole("status")).toContainText("3×")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
  })

test("target creation confirmation survives a refresh error without showing an empty state", async ({
  page,
}) => {
  await page.route("**/api/integrations/github/repos?**", (route) =>
    route.fulfill({ json: { success: true, data: { items: [repo(1)], nextPage: null } } })
  )
  await page.route("**/api/targets", (route) =>
    route.fulfill({ json: { success: true, data: { id: "target-new", name: "example/repo-1" } } })
  )
  await page.route("**/api/targets?**", (route) =>
    route.fulfill({
      status: 503,
      json: { success: false, error: { code: "UNAVAILABLE", message: "Refresh unavailable" } },
    })
  )
  await page.goto("?v26-dashboard=targets&add=1")
  await page.getByLabel("Select repository").selectOption("1")
  await page.getByRole("button", { name: /^Create target$/i }).click()
  await expect(page.getByRole("status")).toContainText("ready for scan setup")
  await expect(page.getByRole("alert")).toContainText("Refresh unavailable")
  await expect(page.getByRole("heading", { name: "No targets yet" })).toHaveCount(0)
})

for (const width of [390, 1280])
  test(`long repository choices and add action fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const longRepo = { ...repo(1), fullName: `example/${"long-repository-name-".repeat(8)}` }
    await page.route("**/api/integrations/github/repos?**", (route) =>
      route.fulfill({ json: { success: true, data: { items: [longRepo], nextPage: null } } })
    )
    await page.goto("?v26-dashboard=github")
    await page.getByRole("button", { name: "Load repositories", exact: true }).click()
    await page.getByRole("button", { name: longRepo.fullName, exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
    const addAction = page.getByRole("button", { name: `Add “${longRepo.fullName}” as target` })
    expect(await addAction.evaluate((element) => element.scrollHeight)).toBeLessThanOrEqual(
      await addAction.evaluate((element) => element.clientHeight)
    )
    await page.screenshot({ path: test.info().outputPath(`github-${width}px.png`), fullPage: true })
  })

test("password reset success is accessible and removes the token before submission", async ({
  page,
}) => {
  let resetRequests = 0
  await page.route("**/api/auth/reset-password", (route) => {
    resetRequests++
    return route.fulfill({ json: { status: true } })
  })
  await page.goto("?v26-dashboard=reset&token=synthetic-one-time-token")
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible()
  await expect(page).not.toHaveURL(/token=/)
  await page.getByLabel("New password", { exact: true }).fill("SyntheticPassword123!")
  await page.getByRole("button", { name: "Reset password", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Password reset successfully")
  await expect(page.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute(
    "href",
    "/sign-in"
  )
  expect(resetRequests).toBe(1)
  await expect(page).not.toHaveURL(/token=/)
})

test("notification retry failure retains already loaded notifications", async ({ page }) => {
  let loads = 0
  await page.route("**/api/notifications?**", (route) => {
    if (++loads > 1)
      return route.fulfill({
        status: 503,
        json: { success: false, error: { code: "UNAVAILABLE", message: "Unavailable" } },
      })
    return route.fulfill({
      json: {
        success: true,
        data: {
          items: [
            {
              id: "notice-1",
              channel: "in_app",
              type: "scan.completed",
              title: "Retained scan notification",
              body: "Review completed",
              status: "sent",
              sentAt: null,
              createdAt: "2026-10-30T10:00:00Z",
            },
          ],
          nextCursor: null,
        },
      },
    })
  })
  await page.route("**/api/notifications/notice-1", (route) =>
    route.fulfill({
      status: 503,
      json: { success: false, error: { code: "UNAVAILABLE", message: "Unavailable" } },
    })
  )
  await page.goto("?v26-dashboard=notifications")
  await page.getByRole("button", { name: "Mark as read", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Failed to mark notification as read")
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Failed to load notifications")
  await expect(page.getByRole("heading", { name: "Retained scan notification" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No notifications", exact: true })).toHaveCount(0)
})

test("members without integration management cannot load private repository choices", async ({
  page,
}) => {
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/integrations/github/")) requests.push(request.url())
  })
  await page.goto("?v26-dashboard=github&viewer=1")
  await expect(page.getByText("Connected as example")).toBeVisible()
  await expect(page.getByRole("button", { name: "Load repositories", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Reconnect GitHub" })).toHaveCount(0)
  expect(requests).toEqual([])
})

test("changing repository search clears a hidden selection before target creation", async ({
  page,
}) => {
  await page.route("**/api/integrations/github/repos?**", (route) =>
    route.fulfill({ json: { success: true, data: { items: [repo(1), repo(2)], nextPage: null } } })
  )
  const created: Array<Record<string, unknown>> = []
  await page.route("**/api/targets", (route) => {
    created.push(route.request().postDataJSON())
    return route.fulfill({
      json: { success: true, data: { id: "target-filtered", name: "example/repo-2" } },
    })
  })
  await page.route("**/api/targets?**", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  await page.goto("?v26-dashboard=targets&add=1")
  await page.getByLabel("Select repository").selectOption("1")
  await expect(page.getByRole("button", { name: /^Create target$/i })).toBeEnabled()
  await page.getByRole("textbox", { name: "Search loaded repositories" }).fill("repo-2")
  await expect(page.getByLabel("Select repository")).toHaveValue("")
  await expect(page.getByRole("button", { name: /^Create target$/i })).toBeDisabled()
  expect(created).toEqual([])
  await page.getByLabel("Select repository").selectOption("2")
  await page.getByRole("button", { name: /^Create target$/i }).click()
  await expect(page.getByRole("status")).toContainText("ready for scan setup")
  expect(created).toHaveLength(1)
  expect(created[0]).toMatchObject({
    name: "example/repo-2",
    repoOwner: "example",
    repoName: "repo-2",
  })
})

test("approval page identity follows pending pagination and retains decisions on operation-only navigation", async ({
  page,
}) => {
  let denied = 0
  await page.route("**/api/agent-approvals/approval-first/deny", (route) => {
    denied++
    return route.fulfill({ json: { success: true, data: {} } })
  })
  await page.goto("?v26-dashboard=approvals-pages")
  await expect(page.locator("#approval-approval-first")).toBeVisible()
  await page
    .locator("#approval-approval-first")
    .getByRole("button", { name: "Deny", exact: true })
    .click()
  await expect(page.locator("#approval-approval-first")).toHaveCount(0)
  await expect(page.locator("#approval-approval-another")).toBeVisible()
  await page.getByRole("button", { name: "Older operations fixture" }).click()
  await expect(page.locator("#approval-approval-first")).toHaveCount(0)
  await expect(page.locator("#approval-approval-another")).toBeVisible()
  await page.getByRole("button", { name: "More pending approvals fixture" }).click()
  await expect(page.locator("#approval-approval-second")).toBeVisible()
  await expect(page.locator("#approval-approval-another")).toHaveCount(0)
  await page.getByRole("button", { name: "Latest activity fixture" }).click()
  await expect(page.locator("#approval-approval-latest")).toBeVisible()
  await expect(page.locator("#approval-approval-second")).toHaveCount(0)
  expect(denied).toBe(1)
})
