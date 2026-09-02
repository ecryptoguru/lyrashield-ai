import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

test("mobile workspace sheet switches data, reaches Billing and signs out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const suffix = crypto.randomUUID()
  const email = `mobile-${suffix}@example.com`
  const password = "Mobile-test-password-123!"
  await page.goto("/sign-up")
  await page.getByLabel("Name").fill("Mobile Tester")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect.poll(() => prisma.user.findUnique({ where: { email } })).not.toBeNull()
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:3100" },
  })
  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
  await expect(
    await page.request.patch("/api/onboarding", {
      data: { skipped: true },
      headers: { Origin: "http://127.0.0.1:3100" },
    })
  ).toBeOK()
  const workspaces: string[] = []
  for (const name of ["Mobile Alpha", "Mobile Beta"]) {
    const response = await page.request.post("/api/workspaces", {
      data: { name, slug: `${name.toLowerCase().replaceAll(" ", "-")}-${suffix}`, mode: "VIBE" },
      headers: { Origin: "http://127.0.0.1:3100" },
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
      headers: { Origin: "http://127.0.0.1:3100" },
    })
  ).toBeOK()
  await page.goto("/dashboard/targets")
  await expect(page.getByText("Mobile Alpha target", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /^Workspace navigation/ }).click()
  await page.getByRole("combobox", { name: "Active workspace" }).selectOption(workspaces[1]!)
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/dashboard/targets")
  await expect(page.getByText("Mobile Beta target", { exact: true })).toBeVisible()
  await expect(page.getByText("Mobile Alpha target", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: /^Workspace navigation/ }).click()
  await page.getByRole("link", { name: "Billing", exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/billing/)
  await page.getByRole("button", { name: /^Workspace navigation/ }).click()
  await page.getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(page).toHaveURL(/\/sign-in/)
})
