import { expect, test } from "@playwright/test"

const setupHealth = {
  version: "lyrashield-setup-health/1.0.0",
  status: "blocked",
  allowed: false,
  checkedAt: "2026-11-05T00:00:00.000Z",
  expiresAt: "2026-11-05T00:01:00.000Z",
  scopeFingerprint: "a".repeat(64),
  scope: {
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "LAUNCH_REVIEW",
    mode: "STANDARD",
    workflow: "REVIEW_TARGET",
    policyFingerprint: null,
    attachmentFingerprint: null,
    authorizationFingerprint: null,
    sourceRevision: null,
  },
  checks: [
    {
      code: "DOMAIN_VERIFICATION_REQUIRED",
      status: "blocked",
      explanation: "Verify control of this domain once.",
      recoveryAction: "VERIFY_DOMAIN",
    },
  ],
  primaryCheck: "DOMAIN_VERIFICATION_REQUIRED",
  limitations: ["Comparison refs resolve only when a review is submitted."],
}

for (const width of [390, 1440]) {
  test(`target assessment remains actionable and readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route("**/api/v1/setup-health?*", (route) =>
      route.fulfill({ json: { success: true, data: setupHealth } })
    )
    await page.goto(`?target-assessment=blocked&theme=dark`)

    await expect(page.getByRole("heading", { name: "Assessment" })).toBeVisible()
    await expect(page.getByText("Not assessed")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Spend" })).toBeVisible()
    await expect(page.getByText("$3.20")).toBeVisible()
    await expect(page.getByText("Unknown — settlement still pending")).toBeVisible()
    await expect(page.getByText("Not persisted")).toBeVisible()
    await expect(page.getByText("Setup blocked")).toBeVisible()
    await expect(page.getByRole("link", { name: "Start launch review" })).toHaveAttribute(
      "href",
      /new=1/
    )

    const primary = page.getByRole("link", { name: "Start launch review" })
    await primary.focus()
    await expect(primary).toBeFocused()
    const box = await primary.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )

    await page.addStyleTag({ content: "html { font-size: 200%; }" })
    await expect(primary).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
  })
}

test("target panels isolate setup failure from assessment, spend and recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let retry = false
  await page.route("**/api/v1/setup-health?*", (route) =>
    route.fulfill(
      retry
        ? { json: { success: true, data: setupHealth } }
        : {
            status: 503,
            json: { success: false, error: { code: "UNAVAILABLE", message: "Setup unavailable" } },
          }
    )
  )
  await page.goto("?target-assessment=failure&theme=light")
  await expect(page.getByRole("heading", { name: "Assessment" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Spend" })).toBeVisible()
  await expect(page.getByText("Finding counts are unavailable")).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Setup unavailable")
  retry = true
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByText("Setup blocked")).toBeVisible()
})

for (const width of [390, 1440]) {
  test(`private release packet stays usable, keyboard accessible and printable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("?release-packet=historical&theme=dark")
    await expect(page.getByRole("heading", { name: "Release App" })).toBeVisible()
    await expect(page.getByText("Signature unavailable").first()).toBeVisible()
    await expect(page.getByText("Historical — not current evidence")).toBeVisible()
    await expect(page.getByText("Unsupported")).toBeVisible()

    const download = page.getByRole("link", { name: "Download CSV" })
    const print = page.getByRole("button", { name: "Print / Save as PDF" })
    await expect(download).toBeVisible()
    await expect(print).toBeVisible()
    await download.focus()
    await expect(download).toBeFocused()
    expect((await download.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await page.keyboard.press("Tab")
    await expect(print).toBeFocused()
    expect((await print.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await expect(download).toHaveAttribute(
      "href",
      "/api/reports/release-packet/packet-1/download?workspaceId=ws-1"
    )

    const finding = page.getByRole("cell", { name: "Potential tenant escape" })
    await expect(finding).toBeVisible()
    await expect(page.getByRole("link", { name: "Open finding" })).toHaveAttribute(
      "href",
      "/dashboard/findings/finding-1"
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )

    await page.addStyleTag({ content: "html { font-size: 200%; }" })
    await expect(download).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )

    await page.emulateMedia({ media: "print" })
    await expect(download).toBeHidden()
    await expect(print).toBeHidden()
  })
}
