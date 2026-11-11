import { expect, test } from "@playwright/test"

for (const width of [390, 1440]) {
  test(`packet actions use private routes and preserve ordinary reports at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("Clipboard denied")) },
        configurable: true,
      })
      document.execCommand = () => false
    })
    const packet = {
      id: "packet-fixture",
      title: "Release packet fixture",
      type: "release_packet",
      status: "generated",
      format: "html",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      scanId: "scan-fixture",
    }
    const ordinary = {
      ...packet,
      id: "ordinary-fixture",
      title: "Ordinary report",
      type: "developer",
    }
    const actions: string[] = []
    await page.route("**/api/scans?**", (route) =>
      route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
    )
    await page.route("**/api/reports**", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: { success: true, data: { items: [packet, ordinary], nextCursor: null } },
        })
      }
      const requestUrl = new URL(route.request().url())
      const { action } = route.request().postDataJSON() as { action: string }
      actions.push(`${requestUrl.pathname}:${action}`)
      return route.fulfill({
        json: {
          success: true,
          data:
            action === "revoke"
              ? { revoked: true, revokedAt: "2026-11-05T00:00:00.000Z" }
              : {
                  token: "a".repeat(64),
                  expiresAt: "2030-01-01T00:00:00.000Z",
                  shareUrl: `/reports/release-packet/shared/packet-fixture?token=${"a".repeat(64)}&workspaceId=workspace-test`,
                },
        },
      })
    })
    await page.goto("?tab=reports")
    const packetCard = page
      .getByRole("heading", { name: /Release packet fixture/ })
      .locator("xpath=../../../..")
    const ordinaryCard = page
      .getByRole("heading", { name: /Ordinary report/ })
      .locator("xpath=../../../..")
    await expect(packetCard.getByRole("heading").getByRole("link")).toHaveAttribute(
      "href",
      "/dashboard/reports/release-packet/packet-fixture"
    )
    await expect(packetCard.getByRole("link", { name: /Download/ })).toHaveAttribute(
      "href",
      "/api/reports/release-packet/packet-fixture/download?workspaceId=workspace-test"
    )
    await expect(ordinaryCard.getByRole("heading").getByRole("link")).toHaveAttribute(
      "href",
      "/api/reports/ordinary-fixture/download?workspaceId=workspace-test"
    )
    await packetCard.getByRole("button", { name: "Create private link" }).focus()
    await page.keyboard.press("Enter")
    await expect(page.getByText(/workspace.*report access/i)).toBeVisible()
    await page.getByRole("button", { name: "Copy link", exact: true }).click()
    await expect(page.getByText(/Failed to copy share link/)).toBeVisible()
    const manualLink = page.getByRole("textbox", { name: "Private release packet link" })
    await manualLink.focus()
    await expect(manualLink).toHaveJSProperty("selectionStart", 0)
    await expect
      .poll(() =>
        manualLink.evaluate(
          (element: HTMLInputElement) => element.selectionEnd === element.value.length
        )
      )
      .toBe(true)
    expect(actions).toEqual(["/api/reports/release-packet/packet-fixture:share"])
    await packetCard.getByRole("button", { name: "Regenerate private link" }).click()
    await expect(packetCard.getByText(/previous link.*stop working/i)).toBeVisible()
    await packetCard.getByRole("button", { name: "Regenerate" }).click()
    await expect.poll(() => actions.length).toBe(2)
    await packetCard.getByRole("button", { name: "Revoke private link" }).click()
    await packetCard.getByRole("button", { name: "Revoke" }).click()
    await expect(packetCard.getByText(/link revoked/i)).toBeVisible()
    await packetCard.getByRole("button", { name: "Create private link" }).click()
    await expect(packetCard.getByRole("button", { name: "Regenerate private link" })).toBeVisible()
    await expect(packetCard.getByText(/link revoked/i)).toHaveCount(0)
    await ordinaryCard.getByRole("button", { name: "Create share link" }).click()
    await expect.poll(() => actions.length).toBe(5)
    expect(actions).toEqual([
      "/api/reports/release-packet/packet-fixture:share",
      "/api/reports/release-packet/packet-fixture:share",
      "/api/reports/release-packet/packet-fixture:revoke",
      "/api/reports/release-packet/packet-fixture:share",
      "/api/reports/ordinary-fixture:share",
    ])
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width)
  })
}

test("pending packet creation cannot rotate the link twice", async ({ page }) => {
  let resolveShare!: () => void
  const pendingShare = new Promise<void>((resolve) => {
    resolveShare = resolve
  })
  let shares = 0
  await page.route("**/api/scans?**", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  await page.route("**/api/reports**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          success: true,
          data: {
            items: [
              {
                id: "packet-fixture",
                title: "Release packet fixture",
                type: "release_packet",
                status: "generated",
                format: "html",
                shareExpiresAt: null,
                revokedAt: null,
                createdAt: "2026-11-01T00:00:00.000Z",
                scanId: null,
              },
            ],
            nextCursor: null,
          },
        },
      })
    shares++
    await pendingShare
    return route.fulfill({
      json: {
        success: true,
        data: {
          token: "a".repeat(64),
          expiresAt: "2030-01-01T00:00:00.000Z",
          shareUrl: "/reports/release-packet/shared/packet-fixture?token=synthetic",
        },
      },
    })
  })
  await page.goto("?tab=reports")
  const create = page.getByRole("button", { name: "Create private link" })
  await create.click()
  await expect(create).toBeDisabled()
  expect(shares).toBe(1)
  resolveShare()
  await expect(page.getByRole("button", { name: "Regenerate private link" })).toBeEnabled()
  expect(shares).toBe(1)
})

for (const width of [390, 1440]) {
  test(`packet creation offers the workspace view without a share link at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    let submittedShare: boolean | undefined
    await page.route("**/api/reports/release-packet", (route) => {
      submittedShare = (route.request().postDataJSON() as { share: boolean }).share
      return route.fulfill({
        json: {
          success: true,
          data: { reportId: "packet-created", packetChecksum: "a".repeat(64), shareUrl: null },
        },
      })
    })
    await page.goto("?release-packet=create")
    await page.getByRole("checkbox", { name: /Create a revocable private link/ }).uncheck()
    await page.getByRole("button", { name: "Create immutable packet" }).click()
    await expect(page.getByText("Release packet created.")).toBeVisible()
    expect(submittedShare).toBe(false)
    await expect(page.getByRole("link", { name: "Open packet" })).toHaveAttribute(
      "href",
      "/dashboard/reports/release-packet/packet-created"
    )
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width)
  })
}
