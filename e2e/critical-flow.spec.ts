import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const password = "E2e-password-123!"

async function signUp(page: import("@playwright/test").Page, email: string, name: string) {
  await page.goto("/sign-up")
  await page.getByLabel("Name").fill(name)
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect.poll(() => prisma.user.findUnique({ where: { email } })).not.toBeNull()
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
  await page.goto("/onboarding")
  await expect(page).toHaveURL(/\/onboarding/)
}

test.afterAll(async () => {
  await prisma.$disconnect()
})

test("anonymous APIs reject access", async ({ request }) => {
  for (const path of [
    "/api/scans?workspaceId=unknown",
    "/api/findings?workspaceId=unknown",
    "/api/reports?workspaceId=unknown",
  ]) {
    expect((await request.get(path)).status()).toBe(401)
  }
})

test("onboarding creates a target and tenant boundaries deny another user", async ({
  page,
  browser,
}) => {
  await signUp(page, `owner-${suffix}@example.com`, "E2E Owner")

  const workspaceResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/workspaces") && response.request().method() === "POST"
  )
  await page.getByLabel("Workspace name").fill(`E2E ${suffix}`)
  await page.getByRole("button", { name: "Create workspace" }).click()
  const workspaceBody = await (await workspaceResponse).json()
  const workspaceId = workspaceBody.data.id as string

  const targetResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/targets") && response.request().method() === "POST"
  )
  await page.getByLabel("Target name").fill("Example target")
  await page.getByLabel("Repo owner").fill("octocat")
  await page.getByLabel("Repo name").fill("Hello-World")
  await page.getByRole("button", { name: "Add target" }).click()
  const targetBody = await (await targetResponse).json()
  const targetId = targetBody.data.id as string
  await expect(page.getByRole("heading", { name: "Choose your goal" })).toBeVisible()

  const scan = await page.request.post("/api/scans", {
    data: { workspaceId, targetId, goal: "TEST_APP", mode: "SAFE" },
  })
  expect(scan.status()).toBe(201)

  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await signUp(otherPage, `other-${suffix}@example.com`, "E2E Other")
  for (const path of ["/api/scans", "/api/findings", "/api/reports"]) {
    expect((await otherPage.request.get(`${path}?workspaceId=${workspaceId}`)).status()).toBe(403)
  }
  await other.close()
})
