/* eslint-disable security/detect-non-literal-fs-filename -- Read only the runner's private synthetic mail directory; no application request controls these paths. */
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "@lyrashield/db"

const email = `reset-mail-${randomUUID()}@example.test`
const oldPassword = "Fixture-old-password-123!"
const newPassword = "Fixture-new-password-456!"
const origin = "http://127.0.0.1:3102"
const headers = { Origin: origin, "x-forwarded-for": "192.0.2.235" }

async function capturedResetLink(exclude?: string): Promise<string | null> {
  const directory = process.env.LYRASHIELD_TEST_AUTH_MAIL_DIR
  if (!directory) throw new Error("Private auth mail fixture is missing")
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".json")) continue
    let message: { email?: string; url?: string }
    try {
      message = JSON.parse(await readFile(join(directory, file), "utf8"))
    } catch {
      throw new Error("Captured reset delivery could not be read")
    }
    if (message.email === email && message.url && message.url !== exclude) return message.url
  }
  return null
}

function capturedResetToken(link: string): string {
  try {
    const url = new URL(link)
    if (url.origin !== origin || !/^\/api\/auth\/reset-password\/[^/]+$/.test(url.pathname)) {
      throw new Error()
    }
    return decodeURIComponent(url.pathname.split("/").at(-1)!)
  } catch {
    throw new Error("Captured reset delivery was invalid")
  }
}

async function navigateCapturedReset(
  page: Pick<Page, "goto" | "getByRole" | "url">,
  link: string
): Promise<void> {
  try {
    await page.goto(link)
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible()
    await expect
      .poll(() => {
        const url = new URL(page.url())
        return url.pathname === "/reset-password" && !url.searchParams.has("token")
      })
      .toBe(true)
  } catch {
    // Playwright navigation errors contain bearer URLs; never retain the raw cause.
    throw new Error("Captured reset navigation failed")
  }
}

test.beforeAll(async () => {
  const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
})

test.afterAll(async () => {
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (user) {
      await prisma.verification.deleteMany({
        where: { value: user.id, identifier: { startsWith: "reset-password:" } },
      })
      await prisma.user.delete({ where: { id: user.id } })
    }
  } finally {
    await prisma.$disconnect()
  }
})

test("omits bearer URLs from navigation, reset-form and parsing failure messages", async () => {
  const link = `${origin}/api/auth/reset-password/${randomUUID()}`
  const failedPage = {
    goto: async () => {
      throw new Error(`Synthetic browser failure for ${link}`)
    },
    getByRole: () => {
      throw new Error(`Synthetic reset form failure for ${link}`)
    },
    url: () => link,
  }
  const error = await navigateCapturedReset(failedPage, link).catch((error: unknown) => error)
  expect(error instanceof Error && error.message === "Captured reset navigation failed").toBe(true)
  expect(error instanceof Error && error.cause === undefined).toBe(true)
  expect(String(error).includes(link)).toBe(false)
  const failedForm = { ...failedPage, goto: async () => null }
  const formError = await navigateCapturedReset(failedForm, link).catch((error: unknown) => error)
  expect(
    formError instanceof Error && formError.message === "Captured reset navigation failed"
  ).toBe(true)
  expect(formError instanceof Error && formError.cause === undefined).toBe(true)
  expect(String(formError).includes(link)).toBe(false)
  let invalid: unknown
  try {
    capturedResetToken(`${link}%invalid`)
  } catch (error) {
    invalid = error
  }
  expect(
    invalid instanceof Error && invalid.message === "Captured reset delivery was invalid"
  ).toBe(true)
  expect(String(invalid).includes(link)).toBe(false)
})

test("redeems a delivered local reset link once and revokes the previous session", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  await expect(
    await request.post("/api/auth/sign-up/email", {
      headers,
      data: { email, password: oldPassword, name: "Disposable mail fixture" },
    })
  ).toBeOK()
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })
  expect((await (await request.get("/api/auth/get-session", { headers })).json())?.user?.id).toBe(
    user.id
  )

  await page.goto("/forgot-password")
  await page.locator("#email").fill(email)
  await page.getByRole("button", { name: "Send reset link", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Check your inbox")
  // Consume the captured delivery, never read the reset token from the database.
  await expect.poll(async () => Boolean(await capturedResetLink())).toBe(true)
  const resetLink = (await capturedResetLink())!
  const token = capturedResetToken(resetLink)
  await navigateCapturedReset(page, resetLink)
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
  const replay = await request.post("/api/auth/reset-password", {
    headers,
    data: { token, newPassword: oldPassword },
  })
  expect(replay.status()).toBe(400)
  expect(await replay.json()).toMatchObject({ code: "INVALID_TOKEN" })
  await expect(
    await request.post("/api/auth/sign-in/email", {
      headers,
      data: { email, password: newPassword },
    })
  ).toBeOK()
  await expect(
    await request.post("/api/auth/request-password-reset", {
      headers,
      data: { email, redirectTo: "/reset-password" },
    })
  ).toBeOK()
  await expect.poll(async () => Boolean(await capturedResetLink(resetLink))).toBe(true)
  const concurrentToken = capturedResetToken((await capturedResetLink(resetLink))!)
  const candidates = ["Fixture-concurrent-A-789!", "Fixture-concurrent-B-012!"]
  const responses = await Promise.all(
    candidates.map((newPassword) =>
      request.post("/api/auth/reset-password", {
        headers,
        data: { token: concurrentToken, newPassword },
      })
    )
  )
  expect(responses.map((response) => response.status()).sort()).toEqual([200, 400])
  const winner = responses.findIndex((response) => response.ok())
  expect(await responses[1 - winner]!.json()).toMatchObject({ code: "INVALID_TOKEN" })
  await expect(
    await request.post("/api/auth/sign-in/email", {
      headers,
      data: { email, password: candidates[winner] },
    })
  ).toBeOK()
  expect(
    (
      await request.post("/api/auth/sign-in/email", {
        headers,
        data: { email, password: candidates[1 - winner] },
      })
    ).ok()
  ).toBe(false)
})
