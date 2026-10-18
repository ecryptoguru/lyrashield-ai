import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  for (const width of [320, 1440]) {
    test(`dashboard cards reflow and controls remain reachable: ${theme}, ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`?dashboard-ux=overview&theme=${theme}`)
      const disconnect = page.getByRole("button", { name: /Disconnect/ }).first()
      await expect(disconnect).toBeVisible()
      for (const control of [
        disconnect,
        page.getByRole("button", { name: "Copy assessed release identity" }),
        page.getByRole("switch"),
      ]) {
        const box = await control.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }
      const cardBounds = await page.locator("main > section li").evaluate((element) => {
        const descendants = [element, ...element.querySelectorAll("*")]
        return descendants.map((node) => ({
          tag: node.tagName,
          right: node.getBoundingClientRect().right,
        }))
      })
      for (const bound of cardBounds) expect(bound.right, bound.tag).toBeLessThanOrEqual(width)
      await expect(
        page.getByRole("img", { name: /from 62\/100 on Oct 1, 2026 to 81\/100 on Oct 8, 2026/ })
      ).toBeVisible()
      await page.getByText("View score history", { exact: true }).click()
      const table = page.getByRole("table", { name: "Security score for each completed scan" })
      await expect(table.getByRole("row")).toHaveCount(4)
      await expect(table.getByRole("cell", { name: "58", exact: true })).toBeVisible()
      const toggle = page.getByRole("switch")
      await toggle.focus()
      await page.keyboard.press("Space")
      await expect(toggle).toHaveAttribute("aria-checked", "true")
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )
    })
  }

  test(`spend-limit feedback is announced and has readable contrast in ${theme}`, async ({
    page,
  }) => {
    let succeed = false
    await page.route("**/api/billing/spend-limit?*", (route) =>
      route.fulfill({
        status: succeed ? 200 : 400,
        json: succeed
          ? { success: true }
          : { success: false, error: { message: "Could not update the spend limit." } },
      })
    )
    await page.goto(`?dashboard-ux=billing&theme=${theme}`)
    await page.getByRole("button", { name: "Save limit" }).click()
    const error = page.getByRole("alert")
    await expect(error).toContainText("Could not update")
    await expect(page.getByLabel("Monthly overage cap (USD)")).toHaveAttribute(
      "aria-describedby",
      "spend-limit-error"
    )
    for (const feedback of [error, page.getByRole("status")]) {
      if (feedback === error) {
        // Keep the failed feedback mounted for its contrast measurement.
      } else {
        succeed = true
        await page.getByRole("button", { name: "Save limit" }).click()
        await expect(feedback).toContainText("Spend limit updated.")
      }
      const ratio = await feedback.evaluate((element) => {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const ctx = canvas.getContext("2d")!
        function luminance(color: string) {
          ctx.clearRect(0, 0, 1, 1)
          ctx.fillStyle = color
          ctx.fillRect(0, 0, 1, 1)
          const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
            const channel = value / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
          })
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
        }
        const foreground = luminance(getComputedStyle(element).color)
        const background = luminance(
          getComputedStyle(element.closest(".bg-card") ?? element.parentElement!.parentElement!)
            .backgroundColor
        )
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      })
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    }
  })
}

test("first-project cancellation restores the remounted trigger's keyboard focus", async ({
  page,
}) => {
  await page.goto("?dashboard-ux=projects")
  await page.getByRole("button", { name: "New Project" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused()
  await page.getByRole("button", { name: "Cancel", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "New Project" })).toBeFocused()
})

test("release identity copy announces failure, allows retry, and announces success", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Denied")
        },
      },
    })
    document.execCommand = () => false
  })
  await page.goto("?dashboard-ux=reports")
  await page.getByRole("button", { name: "Copy assessed release identity" }).click()
  await expect(page.getByRole("alert")).toContainText("Select and copy the release identity above")
  await expect(page.getByRole("button", { name: "Copy assessed release identity" })).toBeFocused()
  await expect(page.locator("code")).toContainText("d4c070ad52dd7e8ca047fe775b53527244c8737d1234")
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    })
  )
  await page.getByRole("button", { name: "Copy assessed release identity" }).click()
  await expect(page.getByRole("status")).toHaveText("Assessed release identity copied.")
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("no-target scheduling and assurance pages offer prerequisite recovery", async ({ page }) => {
  await page.route("**/api/schedules?*", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  await page.route("**/api/targets?*", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  await page.goto("?dashboard-ux=schedules")
  await expect(page.getByRole("link", { name: "Manage targets" })).toHaveAttribute(
    "href",
    "/dashboard/targets?add=1"
  )
  await expect(page.getByRole("button", { name: "New Schedule" })).toHaveCount(0)
  await page.goto("?dashboard-ux=assurance")
  await expect(page.getByRole("link", { name: "Manage targets" })).toHaveAttribute(
    "href",
    "/dashboard/targets?add=1"
  )
})

test("target loading errors stay distinct from an empty workspace and can be retried", async ({
  page,
}) => {
  let retry = false
  await page.route("**/api/schedules?*", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  await page.route("**/api/targets?*", (route) =>
    route.fulfill(
      retry
        ? { json: { success: true, data: { items: [], nextCursor: null } } }
        : { status: 500, json: { success: false, error: { message: "Unavailable" } } }
    )
  )
  await page.goto("?dashboard-ux=schedules")
  await expect(page.getByRole("alert")).toContainText("Could not load targets for scheduling")
  await expect(page.getByRole("link", { name: "Manage targets" })).toHaveCount(0)
  retry = true
  await page.getByRole("button", { name: /retry/i }).click()
  await expect(page.getByRole("link", { name: "Manage targets" })).toBeVisible()
})

test("schedule creation keeps its accessible name during a delayed request and restores focus", async ({
  page,
}) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/targets?*", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          items: [{ id: "target-1", name: "Checkout", type: "URL", apiSpecUrl: null }],
          nextCursor: null,
        },
      },
    })
  )
  await page.route("**/api/schedules*", async (route) => {
    if (route.request().method() === "POST") {
      await pending
      await route.fulfill({ json: { success: true, data: { id: "schedule-1" } } })
    } else await route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  })
  await page.goto("?dashboard-ux=schedules")
  await expect(page.getByRole("button", { name: "New Schedule" })).toHaveCount(1)
  await page.getByRole("button", { name: "New Schedule" }).click()
  await page.getByLabel("Target", { exact: true }).selectOption("target-1")
  await page.getByRole("button", { name: "Create", exact: true }).click()
  const creating = page.getByRole("button", { name: "Creating schedule…" })
  await expect(creating).toBeDisabled()
  await expect(creating).toHaveAttribute("aria-busy", "true")
  release()
  await expect(page.getByRole("button", { name: "New Schedule" })).toBeFocused()
})

test("license continuation links retain submitted filters and reset the cursor on the first page", async ({
  page,
}) => {
  await page.goto("?dashboard-ux=licenses")
  const next = new URL(
    (await page.getByRole("link", { name: "Next page" }).getAttribute("href")) ?? "",
    "https://example.test"
  )
  expect(next.searchParams.get("q")).toBe("owner+test@example.com")
  expect(next.searchParams.get("status")).toBe("revoked")
  expect(next.searchParams.get("cursor")).toBe("next-page")
  const first = new URL(
    (await page.getByRole("link", { name: "First page" }).getAttribute("href")) ?? "",
    "https://example.test"
  )
  expect(first.searchParams.get("status")).toBe("revoked")
  expect(first.searchParams.has("cursor")).toBe(false)
})

test("billing validates the amount locally without treating a failed request as an invalid field", async ({
  page,
}) => {
  let submissions = 0
  await page.route("**/api/billing/spend-limit?*", (route) => {
    submissions++
    return route.fulfill({
      status: 503,
      json: { success: false, error: { message: "Try again later." } },
    })
  })
  await page.goto("?dashboard-ux=billing")
  const amount = page.getByLabel("Monthly overage cap (USD)")
  await page.getByRole("button", { name: "Save limit" }).click()
  await expect(page.getByRole("alert")).toHaveText("Try again later.")
  await expect(amount).toHaveAttribute("aria-invalid", "false")
  await amount.fill("")
  await page.getByRole("button", { name: "Save limit" }).click()
  await expect(amount).toHaveAttribute("aria-invalid", "true")
  await expect(page.getByRole("alert")).toContainText("between $0 and $100,000")
  expect(submissions).toBe(1)
  await amount.fill("100001")
  expect(await amount.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(
    true
  )
})

test("custom finding and agent controls provide 44px touch targets at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("?findings")
  const sort = page.getByRole("combobox", { name: "Sort loaded results" })
  await expect(sort).toBeVisible()
  expect((await sort.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.goto("?agents")
  for (const control of await page.locator('input[type="search"], select').all()) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
})

test("target fetch failure preserves schedules already loaded", async ({ page }) => {
  await page.route("**/api/targets?*", (route) =>
    route.fulfill({ status: 500, json: { success: false, error: { message: "Unavailable" } } })
  )
  await page.route("**/api/schedules?*", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          nextCursor: null,
          items: [
            {
              id: "schedule-existing",
              targetId: "target-existing",
              cron: "0 0 * * 0",
              goal: "SECURITY",
              mode: "QUICK",
              enabled: true,
              lastRunAt: null,
              nextRunAt: null,
              createdAt: "2026-10-01T00:00:00Z",
              target: {
                id: "target-existing",
                name: "Existing checkout target",
                type: "URL",
                url: "https://example.test",
                apiSpecUrl: null,
              },
            },
          ],
        },
      },
    })
  )
  await page.goto("?dashboard-ux=schedules")
  await expect(page.getByRole("alert")).toContainText("Could not load targets for scheduling")
  await expect(page.getByRole("heading", { name: "Existing checkout target" })).toBeVisible()
})

test("changing scheduled target resets an unavailable API review to the new target's options", async ({
  page,
}) => {
  await page.route("**/api/schedules?*", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  await page.route("**/api/targets?*", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          items: [
            {
              id: "api-target",
              name: "API",
              type: "API",
              apiSpecUrl: "https://example.test/openapi.json",
            },
            { id: "url-target", name: "Web", type: "URL", apiSpecUrl: null },
          ],
          nextCursor: null,
        },
      },
    })
  )
  await page.goto("?dashboard-ux=schedules")
  await page.getByRole("button", { name: "New Schedule" }).click()
  await page.getByLabel("Target", { exact: true }).selectOption("api-target")
  await page.getByRole("button", { name: "Advanced", exact: true }).click()
  const depth = page.getByLabel("Scan depth", { exact: true })
  const apiOption = await depth
    .locator("option")
    .evaluateAll(
      (options: HTMLOptionElement[]) =>
        options.find((option) => /Contract/.test(option.text) && !option.disabled)?.value
    )
  expect(apiOption).toBeTruthy()
  await depth.selectOption(apiOption!)
  await page.getByLabel("Target", { exact: true }).selectOption("url-target")
  await expect(depth).not.toHaveValue(apiOption!)
  await expect(page.getByRole("status")).toContainText("Review depth reset")
})

test("score history handles an empty state and a single completed scan accessibly", async ({
  page,
}) => {
  await page.goto("?dashboard-ux=charts&empty")
  await expect(page.getByText("Complete a scan to establish the score trend.")).toBeVisible()
  await expect(page.getByRole("img")).toHaveCount(0)
  await page.goto("?dashboard-ux=charts&single")
  await expect(
    page.getByRole("img", { name: /across 1 completed scan, from 62\/100/ })
  ).toBeVisible()
  await page.getByText("View score history", { exact: true }).click()
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2)
})
