import { expect, test } from "@playwright/test"

test("empty connected repository list settles and supports manual entry", async ({ page }) => {
  let requests = 0
  await page.route("**/api/integrations/github/repos?**", (route) => {
    requests++
    return route.fulfill({ json: { success: true, data: [] } })
  })
  await page.goto("?dashboard-ux=first-scan&github-connected")
  await expect(page.getByText("No repositories found.")).toBeVisible()
  await page.getByRole("button", { name: "Enter manually", exact: true }).click()
  await expect(page.getByLabel("Repo Owner")).toBeVisible()
  await expect(page.getByText("Loading repositories...")).toBeHidden()
  expect(requests).toBe(1)
})

test("connected repository setup finishes loading and recovers after changing source", async ({
  page,
}) => {
  let releaseRequest: (() => void) | undefined
  let requests = 0
  await page.route("**/api/integrations/github/repos?**", async (route) => {
    requests++
    if (requests === 1)
      await new Promise<void>((resolve) => {
        releaseRequest = resolve
      })
    await route.fulfill({
      json: {
        success: true,
        data: [
          {
            id: 42,
            fullName: "example/app",
            name: "app",
            owner: "example",
            defaultBranch: "main",
            private: true,
            htmlUrl: "https://github.com/example/app",
            installationId: "installation-1",
          },
        ],
      },
    })
  })
  await page.goto("?dashboard-ux=first-scan&github-connected")
  await expect(page.getByText("Loading repositories...")).toBeVisible()
  await expect.poll(() => requests).toBe(1)
  releaseRequest!()
  await expect(page.getByRole("combobox", { name: "Select repository" })).toBeVisible()
  await page.getByRole("combobox", { name: "Select repository" }).selectOption("42")
  await expect(page.getByRole("button", { name: "Continue to scan setup" })).toBeEnabled()
  await page.getByRole("button", { name: "URL", exact: true }).click()
  await page.getByRole("button", { name: "Repository", exact: true }).click()
  await expect(page.getByRole("combobox", { name: "Select repository" })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Select repository" })).toHaveValue("42")
})

for (const width of [390, 1440]) {
  test(`first scan continues from source to explicit confirmation and progress at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    let scanPosts = 0
    await page.route("**/api/targets", (route) =>
      route.fulfill({ json: { success: true, data: { id: "target-new", name: "example.com" } } })
    )
    await page.route("**/api/scans/eligibility?**", (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            allowed: true,
            code: null,
            message: null,
            plan: "STARTER",
            isTrial: false,
            remainingMinutes: 100,
          },
        },
      })
    )
    await page.route("**/api/scans/attachments?**", (route) =>
      route.fulfill({ json: { success: true, data: { items: [] } } })
    )
    await page.route("**/api/scans?**", (route) =>
      route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
    )
    await page.route("**/api/scans", (route) => {
      scanPosts++
      expect(route.request().postDataJSON().targetId).toBe("target-new")
      expect(route.request().headers()["idempotency-key"]).toBeTruthy()
      return route.fulfill({
        json: {
          success: true,
          data: {
            id: "scan-new",
            status: "QUEUED",
            goal: "TEST_APP",
            mode: "SAFE",
            triggerType: "MANUAL",
            startedAt: null,
            endedAt: null,
            summary: null,
            errorCategory: null,
            errorMessage: null,
            findingCount: 0,
            target: {
              id: "target-new",
              name: "example.com",
              type: "WEB_APP",
              url: "https://example.com",
              apiSpecUrl: null,
              repoFullName: null,
            },
            createdAt: "2026-10-09T00:00:00.000Z",
          },
        },
      })
    })
    await page.goto("?dashboard-ux=first-scan")
    await page.getByLabel("URL", { exact: true }).fill("https://example.com")
    await page.getByLabel("URL", { exact: true }).press("Tab")
    await expect(page.getByLabel("Target name")).toHaveValue("example.com")
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "Continue to scan setup" }).click()
    const dialog = page.getByRole("dialog", { name: "Start a scan" })
    await expect(dialog).toBeVisible()
    expect(scanPosts).toBe(0)
    await expect(dialog.getByRole("button", { name: /^Start scan$/i })).toBeEnabled()
    await dialog.getByRole("button", { name: /^Start scan$/i }).click()
    await expect(page.getByRole("status")).toContainText("Scan progress: /dashboard/scans/scan-new")
    expect(scanPosts).toBe(1)
  })

  test(`readiness leads with next action and discloses optional release check at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("?dashboard-ux=readiness")
    const action = page.getByRole("link", { name: "Start your first scan" })
    await expect(action).toBeVisible()
    expect((await action.boundingBox())!.y).toBeLessThan(600)
    await expect(page.getByLabel("Check a specific release (optional)")).toBeHidden()
    await page.getByText("Check a specific release (optional)", { exact: true }).first().click()
    await expect(page.getByLabel("Check a specific release (optional)")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
  })
}

test("combinable filters survive pagination and reset preserves target and scan", async ({
  page,
}) => {
  const requests: URL[] = []
  await page.route("**/api/findings?**", (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    const empty = url.searchParams.get("q") === "missing"
    return route.fulfill({
      json: {
        success: true,
        data: {
          items: empty
            ? []
            : [
                {
                  id: url.searchParams.get("cursor") ? "second" : "matched",
                  title: url.searchParams.get("cursor") ? "Second finding" : "Matched finding",
                  summary: "Fixture finding",
                  severity: "HIGH",
                  status: "OPEN",
                  verified: true,
                  verificationStatus: "VALIDATED",
                  confidence: "HIGH",
                  firstSeenAt: "2026-10-01T00:00:00.000Z",
                  lastSeenAt: "2026-10-01T00:00:00.000Z",
                },
              ],
          nextCursor: empty || url.searchParams.has("cursor") ? null : "next",
        },
      },
    })
  })
  await page.goto("?findings&scanId=scan-scope&target=target-test")
  await page.getByRole("combobox", { name: "Filter by severity" }).selectOption("HIGH")
  await expect(page.getByRole("button", { name: /Matched finding/ })).toBeVisible()
  await page.getByRole("combobox", { name: "Filter by evidence" }).selectOption("VERIFIED")
  await expect(page).toHaveURL(/evidence=VERIFIED/)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("button", { name: /Second finding/ })).toBeVisible()
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({
    workspaceId: "workspace-test",
    status: "OPEN",
    severity: "HIGH",
    verified: "true",
    observedInScanId: "scan-scope",
    targetId: "target-test",
    cursor: "next",
  })
  await page.getByRole("searchbox").fill("missing")
  await expect(page.getByText("No matching findings", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Reset filters and search" }).click()
  await expect(page.getByRole("button", { name: /Matched finding/ })).toBeVisible()
  const last = requests.at(-1)!.searchParams
  expect(last.get("observedInScanId")).toBe("scan-scope")
  expect(last.get("targetId")).toBe("target-test")
  for (const key of ["status", "severity", "verified", "q", "cursor"])
    expect(last.has(key)).toBe(false)
})

for (const theme of ["light", "dark"]) {
  test(`all severity badge labels meet small-text contrast in ${theme}`, async ({ page }) => {
    await page.goto(`?findings&severities&theme=${theme}`)
    for (const label of ["Critical", "High", "Medium", "Low", "Info", "Independently verified"]) {
      if (label === "Independently verified")
        await page.goto(`?findings&theme=${theme}&evidence=VERIFIED`)
      const badge = page.getByText(label, { exact: true }).filter({ visible: true }).last()
      const ratio = await badge.evaluate((element) => {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const context = canvas.getContext("2d")!
        const style = getComputedStyle(element)
        const surface = element.closest(".bg-card") ?? document.body
        const paint = (colors: string[]) => {
          context.clearRect(0, 0, 1, 1)
          for (const color of colors) {
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
          }
          const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((byte) => {
            const channel = byte / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
          })
          return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722
        }
        const foreground = paint([style.color])
        const background = paint([
          getComputedStyle(document.body).backgroundColor,
          getComputedStyle(surface).backgroundColor,
          style.backgroundColor,
        ])
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      })
      expect(ratio, label).toBeGreaterThanOrEqual(4.5)
    }
  })
}

for (const compatible of [true, false]) {
  test(`source conflict ${compatible ? "reuses only server-compatible target" : "keeps incompatible target as an error"}`, async ({
    page,
  }) => {
    await page.route("**/api/targets", (route) =>
      route.fulfill({
        status: 409,
        json: {
          success: false,
          error: {
            code: "TARGET_EXISTS",
            message: "Review the existing target settings.",
            ...(compatible ? { details: { existingTargetId: "target-existing" } } : {}),
          },
        },
      })
    )
    await page.route("**/api/scans/eligibility?**", (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            allowed: true,
            code: null,
            message: null,
            plan: "STARTER",
            isTrial: false,
            remainingMinutes: 100,
          },
        },
      })
    )
    await page.route("**/api/scans/attachments?**", (route) =>
      route.fulfill({ json: { success: true, data: { items: [] } } })
    )
    await page.goto("?dashboard-ux=first-scan")
    await page.getByLabel("URL", { exact: true }).fill("https://example.com")
    await page.getByLabel("URL", { exact: true }).press("Tab")
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "Continue to scan setup" }).click()
    if (compatible) await expect(page.getByRole("dialog", { name: "Start a scan" })).toBeVisible()
    else {
      await expect(page.getByRole("alert")).toContainText("Review the existing target settings.")
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.getByLabel("URL", { exact: true })).toHaveValue("https://example.com")
    }
  })
}
