import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

const email = `launch-reset-${Date.now()}@example.test`
const oldPassword = "Fixture-old-password-123!"
const newPassword = "Fixture-new-password-456!"
const headers = { Origin: "http://127.0.0.1:3100", "x-forwarded-for": "192.0.2.233" }

test.afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (user) {
    await prisma.verification.deleteMany({
      where: { value: user.id, identifier: { startsWith: "reset-password:" } },
    })
    await prisma.user.delete({ where: { id: user.id } })
  }
  await prisma.$disconnect()
})

test("password reset is single-use and revokes the prior authenticated session", async ({
  page,
  request,
}) => {
  await expect(
    await request.post("/api/auth/sign-up/email", {
      headers,
      data: {
        email,
        password: oldPassword,
        name: "Reset fixture",
        issuer: "https://untrusted.example",
      },
    })
  ).toBeOK()
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  const account = await prisma.account.findFirstOrThrow({
    where: { userId: user.id, providerId: "credential" },
    select: { issuer: true },
  })
  expect(account.issuer).toBe("local:credential")
  const before = await request.get("/api/auth/get-session", { headers })
  expect((await before.json())?.user?.id).toBe(user.id)
  await expect(
    await request.post("/api/auth/request-password-reset", {
      headers,
      data: { email, redirectTo: "/reset-password" },
    })
  ).toBeOK()
  // Read only this disposable user's generated token; mailbox delivery remains a separate acceptance check.
  const verification = await prisma.verification.findFirstOrThrow({
    where: { value: user.id, identifier: { startsWith: "reset-password:" } },
    orderBy: { createdAt: "desc" },
  })
  const token = verification.identifier.slice("reset-password:".length)
  await page.goto(
    `/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=/reset-password`
  )
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible()
  await page.locator("#password").fill(newPassword)
  await page.getByRole("button", { name: "Reset password", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Password reset successfully")
  expect(new URL(page.url()).searchParams.has("token")).toBe(false)
  await page.getByRole("link", { name: "Continue to sign in" }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
  expect(await (await request.get("/api/auth/get-session", { headers })).json()).toBeNull()
  expect(
    (
      await request.post("/api/auth/sign-in/email", {
        headers,
        data: { email, password: oldPassword },
      })
    ).ok()
  ).toBe(false)
  await expect(
    await request.post("/api/auth/sign-in/email", {
      headers,
      data: { email, password: newPassword },
    })
  ).toBeOK()
  expect(
    (
      await request.post("/api/auth/reset-password", {
        headers,
        data: { token, newPassword: oldPassword },
      })
    ).ok()
  ).toBe(false)
})
