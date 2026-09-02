import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

test("mobile workspace sheet switches data, reaches Billing and signs out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const suffix = crypto.randomUUID()
  const forwardedFor = "203.0.113.241"
  const email = `mobile-${suffix}@example.com`
  const password = "Mobile-test-password-123!"
  await page.setExtraHTTPHeaders({ "x-forwarded-for": forwardedFor })
  await page.goto("/sign-up")
  await page.getByLabel("Name").fill("Mobile Tester")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect.poll(() => prisma.user.findUnique({ where: { email } })).not.toBeNull()
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
  await expect(
    await page.request.patch("/api/onboarding", {
      data: { skipped: true },
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    })
  ).toBeOK()
  const workspaces: string[] = []
  for (const name of ["Mobile Alpha", "Mobile Beta"]) {
    const response = await page.request.post("/api/workspaces", {
      data: { name: `${name} ${suffix}`, mode: "VIBE" },
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    })
    await expect(response).toBeOK()
    const { data } = await response.json()
    workspaces.push(data.id)
    await prisma.target.create({
      data: {
        workspaceId: data.id,
        name: `${name} target`,
        type: "WEB_APP",
        url: "https://example.com",
      },
    })
  }
  await expect(
    await page.request.post("/api/workspaces/active", {
      data: { workspaceId: workspaces[0] },
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    })
  ).toBeOK()
  await page.goto("/dashboard/targets")
  await expect(page.getByText("Mobile Alpha target", { exact: true })).toBeVisible()
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } })
  const payload = `<img src=x onerror=alert(1)> ${"unbroken".repeat(70)} END_OF_EXACT_INPUT`
  const approval = await prisma.agentApproval.create({
    data: {
      workspaceId: workspaces[0]!,
      requestedById: owner.id,
      actionName: "local.fixture",
      inputHash: `non-executable-${suffix}`,
      input: { payload, nested: { enabled: false } },
    },
  })
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/dashboard/approvals")
    await page.getByText("Review exact action input", { exact: true }).click()
    const input = page.locator("pre").filter({ hasText: "END_OF_EXACT_INPUT" })
    await expect(input).toHaveText(payload)
    await expect(input.locator("img")).toHaveCount(0)
    await page.getByRole("button", { name: "Approve", exact: true }).click()
    for (const element of [
      input,
      page.getByRole("button", { name: "Approve action", exact: true }),
      page.getByRole("button", { name: "Cancel", exact: true }),
    ]) {
      await element.scrollIntoViewIfNeeded()
      await expect(element).toBeInViewport()
      const bounds = await element.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    }
    expect(await input.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeFocused()
    expect(
      (await prisma.agentApproval.findUniqueOrThrow({ where: { id: approval.id } })).status
    ).toBe("PENDING")
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/dashboard/targets")
  await page.evaluate(() => {
    ;(window as Window & { workspaceDocumentMarker?: string }).workspaceDocumentMarker = "alpha"
  })
  await page.getByRole("button", { name: /^Workspace navigation/ }).click()
  await page.getByRole("combobox", { name: "Active workspace" }).selectOption(workspaces[1]!)
  await expect(page).toHaveURL(/\/dashboard$/)
  expect(
    await page.evaluate(
      () => (window as Window & { workspaceDocumentMarker?: string }).workspaceDocumentMarker
    )
  ).toBeUndefined()
  await page.getByRole("link", { name: "Targets", exact: true }).click()
  await expect(page.getByText("Mobile Beta target", { exact: true })).toBeVisible()
  await expect(page.getByText("Mobile Alpha target", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: /^Workspace navigation/ }).click()
  await page.getByRole("link", { name: "Billing", exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/billing/)
  await page.getByRole("button", { name: /^Workspace navigation/ }).click()
  await page.getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(page).toHaveURL(/\/sign-in/)
})
