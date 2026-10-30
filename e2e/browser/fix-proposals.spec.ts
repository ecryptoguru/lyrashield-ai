import { test, expect } from "@playwright/test"

for (const width of [390, 1280])
  for (const theme of ["light", "dark"]) {
    test(`proposal guidance remains visible and accessible at ${width}px (${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text())
      })
      await page.goto(`?fixProposals&theme=${theme}`)
      await expect(page).toHaveTitle(/.+/)
      await expect(page.getByRole("heading", { name: "Proposed fixes", exact: true })).toBeVisible()
      const ready = page.getByRole("article", {
        name: /requiring application compatibility review/,
      })
      await expect(ready.getByText("Ready for review", { exact: true })).toBeVisible()
      await expect(ready.getByText("Review score: 95", { exact: true })).toBeVisible()
      await ready.getByRole("button", { name: "What the review score means" }).focus()
      await expect(page.getByRole("tooltip")).toContainText("does not verify security")
      await expect(
        ready.getByText("Application compatibility is unverified.", { exact: true })
      ).toBeVisible()
      const disclosure = ready.locator("summary")
      await disclosure.focus()
      await page.keyboard.press("Enter")
      await expect(ready.locator("details")).toHaveAttribute("open", "")
      await expect(ready.locator("details p")).toContainText(
        "before marking the draft ready for merge"
      )
      await page.keyboard.press("Enter")
      await expect(ready.locator("details")).not.toHaveAttribute("open", "")
      const failed = page.getByRole("article", { name: /needs another attempt/ })
      await expect(failed.getByText("Generation failed", { exact: true })).toBeVisible()
      await failed.locator("summary").click()
      await expect(failed.locator("details p")).toContainText("request a new proposal")
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      await expect(page.locator("vite-error-overlay, nextjs-portal")).toHaveCount(0)
      await page.screenshot({ path: `/tmp/lyra-php-fixes-${width}-${theme}.png`, fullPage: true })
      expect(errors).toEqual([])
    })
  }

for (const width of [390, 1280]) {
  test(`approval request is accessible and bound to the proposal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    let body: unknown
    await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) => {
      body = route.request().postDataJSON()
      await route.fulfill({
        json: { success: true, data: { status: "pending_approval", approvalId: "approval-test" } },
      })
    })
    await page.goto("?fixProposals")
    const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
    await expect(
      page
        .getByRole("article", { name: /Summary only/ })
        .getByRole("button", { name: "Create pull request" })
    ).toHaveCount(0)
    const button = ready.getByRole("button", { name: "Create pull request" })
    await button.focus()
    await page.keyboard.press("Enter")
    const confirm = ready.getByRole("button", { name: "Request approval" })
    await expect(confirm).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(ready.getByRole("status")).toContainText("awaiting review")
    await expect(ready.getByRole("link", { name: "View approval" })).toHaveAttribute(
      "href",
      "/dashboard/approvals"
    )
    expect(body).toEqual({ workspaceId: "workspace-test" })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  })
}

test("proposal approval is hidden without permission", async ({ page }) => {
  await page.goto("?fixProposals&noPermission=1")
  await expect(page.getByRole("button", { name: "Create pull request" })).toHaveCount(0)
})

test("inactive repository failure remains visible with a status check", async ({ page }) => {
  await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) => {
    await route.fulfill({
      status: 409,
      json: {
        success: false,
        error: { code: "NO_REPOSITORY_LINK", message: "Connect a repository first." },
      },
    })
  })
  await page.goto("?fixProposals")
  const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
  await ready.getByRole("button", { name: "Create pull request" }).click()
  await ready.getByRole("button", { name: "Request approval" }).click()
  await expect(ready.getByRole("alert")).toContainText("Connect a repository first.")
  await expect(ready.getByRole("button", { name: "Check PR status" })).toBeEnabled()
  await expect(ready.getByRole("status")).toContainText("connection is inactive")
})

test("later pages preserve stored-patch action eligibility", async ({ page }) => {
  await page.route("**/api/fix-proposals?**", async (route) => {
    await route.fulfill({
      json: {
        success: true,
        data: {
          items: [
            {
              id: "later-proposal",
              kind: "patch",
              summary: "Review the generated patch.",
              status: "ready",
              hasStoredPatch: true,
              createdAt: "2026-10-23T00:00:00Z",
              finding: {
                id: "later-finding",
                title: "Later proposal",
                severity: "HIGH",
                status: "OPEN",
              },
              pullRequests: [],
            },
          ],
          nextCursor: null,
        },
      },
    })
  })
  await page.goto("?fixProposals&withMore")
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(
    page
      .getByRole("article", { name: "Proposed fix for Later proposal" })
      .getByRole("button", { name: "Create pull request" })
  ).toBeVisible()
})

for (const width of [390, 1280]) {
  test(`shows confirmed PR success and reconciles pending approval at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            success: true,
            data: {
              status: "opened",
              prNumber: 42,
              prUrl: "https://github.com/owner/repo/pull/42",
            },
          },
        })
      return route.fulfill({
        json: { success: true, data: { status: "pending_approval", approvalId: "approval-test" } },
      })
    })
    await page.route("**/api/fix-proposals/composer-ready/create-pr?*", async (route) =>
      route.fulfill({
        json: {
          success: true,
          data: { status: "opened", prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" },
        },
      })
    )
    await page.goto("?fixProposals")
    const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
    await ready.getByRole("button", { name: "Create pull request" }).click()
    await ready.getByRole("button", { name: "Request approval", exact: true }).click()
    await expect(ready.getByRole("status")).toContainText("awaiting review")
    await ready.getByRole("button", { name: "Check PR status" }).click()
    await expect(ready.getByRole("status")).toContainText("Pull request #42 is open")
    await expect(ready.getByRole("link", { name: "View pull request" })).toHaveAttribute(
      "href",
      "https://github.com/owner/repo/pull/42"
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  })
}

test("shows recovery without claiming an uncertain PR was opened", async ({ page }) => {
  await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) =>
    route.fulfill({ json: { success: true, data: { status: "recovery_required" } } })
  )
  await page.goto("?fixProposals")
  const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
  await ready.getByRole("button", { name: "Create pull request" }).click()
  await ready.getByRole("button", { name: "Request approval", exact: true }).click()
  await expect(ready.getByRole("status")).toContainText("needs recovery")
  await expect(ready.getByRole("button", { name: "Check PR status" })).toBeVisible()
  await expect(ready.getByRole("link", { name: "View pull request" })).toHaveCount(0)
})

for (const [status, text] of [
  ["opening", "pending or opening"],
  ["expired", "Approval expired"],
  ["stale", "is stale"],
  ["closed", "will not be reopened"],
  ["merged", "Review the retest receipt"],
  ["failed", "could not be opened"],
] as const) {
  test(`renders honest ${status} state`, async ({ page }) => {
    await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) =>
      route.fulfill({ json: { success: true, data: { status } } })
    )
    await page.goto("?fixProposals")
    const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
    await ready.getByRole("button", { name: "Create pull request" }).click()
    await ready.getByRole("button", { name: "Request approval", exact: true }).click()
    await expect(ready.getByRole("status")).toContainText(text)
    await expect(ready.getByRole("link", { name: "View pull request" })).toHaveCount(0)
  })
}

test("does not report success for an opened result missing PR identity", async ({ page }) => {
  await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) =>
    route.fulfill({ json: { success: true, data: { status: "opened" } } })
  )
  await page.goto("?fixProposals")
  const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
  await ready.getByRole("button", { name: "Create pull request" }).click()
  await ready.getByRole("button", { name: "Request approval", exact: true }).click()
  await expect(ready.getByRole("alert")).toBeVisible()
  await expect(ready.getByRole("link", { name: "View pull request" })).toHaveCount(0)
})

for (const outcome of [
  {
    status: "stale",
    nextAction: "retest",
    reason: "The repository changed since the scan. Retest and generate a new proposal.",
  },
  {
    status: "failed",
    nextAction: "regenerate_proposal",
    reason: "Execution stopped before GitHub writes. Review the proposal and generate a new one.",
  },
  {
    status: "stale",
    nextAction: "request_approval",
    reason: "The approval no longer matches this stored patch. Request a new approval.",
  },
  {
    status: "expired",
    nextAction: "request_approval",
    reason: "Approval expired. Request a new approval for this stored patch.",
  },
] as const) {
  test(`follows backend ${outcome.status}/${outcome.nextAction} guidance`, async ({ page }) => {
    await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) =>
      route.fulfill({ json: { success: true, data: outcome } })
    )
    await page.goto("?fixProposals")
    const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
    await ready.getByRole("button", { name: "Create pull request" }).click()
    await ready.getByRole("button", { name: "Request approval", exact: true }).click()
    await expect(ready.getByRole("status")).toContainText(outcome.reason)
    const approvalAction = ready.getByRole("button", { name: "Create pull request" })
    if (outcome.nextAction === "request_approval") await expect(approvalAction).toBeEnabled()
    else await expect(approvalAction).toHaveCount(0)
    await expect(ready.getByRole("button", { name: "Check PR status" })).toBeEnabled()
  })
}

test("keeps terminal failure guidance from the POST error response", async ({ page }) => {
  const outcome = {
    status: "failed",
    nextAction: "regenerate_proposal",
    reason: "Execution stopped before GitHub writes. Review the proposal and generate a new one.",
  }
  await page.route("**/api/fix-proposals/composer-ready/create-pr", async (route) =>
    route.fulfill({
      status: 502,
      json: {
        success: false,
        error: {
          code: "FIX_PR_FAILED",
          message: "Fix PR execution did not complete.",
          details: outcome,
        },
      },
    })
  )
  await page.goto("?fixProposals")
  const ready = page.getByRole("article", { name: /requiring application compatibility review/ })
  await ready.getByRole("button", { name: "Create pull request" }).click()
  await ready.getByRole("button", { name: "Request approval", exact: true }).click()
  await expect(ready.getByRole("status")).toContainText(outcome.reason)
  await expect(ready.getByRole("button", { name: "Create pull request" })).toHaveCount(0)
  await expect(ready.getByRole("button", { name: "Check PR status" })).toBeEnabled()
})
