import { createHmac } from "node:crypto"
import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

const adminEmail = "ankit@lyrashieldai.com"
const password = "E2e-admin-password-123!"
// Keep this privileged flow out of the randomized 192.0.2.0/24 buckets used by
// the parallel critical-flow and AI-assurance suites.
const forwardedFor = "203.0.113.240"

function totpFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret")
  if (!secret) throw new Error("Authenticator URI has no secret")
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const character of secret.toUpperCase().replace(/=+$/, "")) {
    const value = alphabet.indexOf(character)
    if (value < 0) throw new Error("Authenticator URI has an invalid base32 secret")
    bits += value.toString(2).padStart(5, "0")
  }
  const bytes = Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
      Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)
    )
  )
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const digest = createHmac("sha1", bytes).update(counter).digest()
  const offset = digest.at(-1)! & 0x0f
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return binary.toString().padStart(6, "0")
}

function requireDisposableDatabase() {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "")
  if (!new Set(["127.0.0.1", "localhost"]).has(databaseUrl.hostname)) {
    throw new Error("Platform admin E2E requires a disposable local database")
  }
}

test.beforeAll(async () => {
  requireDisposableDatabase()
  await prisma.user.deleteMany({ where: { email: adminEmail } })
})

test.afterAll(async () => {
  try {
    const user = await prisma.user.findUnique({
      where: { email: adminEmail },
      select: { id: true },
    })
    if (user) {
      await prisma.platformAdminAudit.deleteMany({ where: { actorUserId: user.id } })
      await prisma.user.delete({ where: { id: user.id } })
    }
  } finally {
    await prisma.$disconnect()
  }
})

test("admin enrollment, deny-by-default, TOTP sign-in, and console work end to end", async ({
  page,
}) => {
  const browserErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  await page.setExtraHTTPHeaders({ "x-forwarded-for": forwardedFor })

  await page.goto("/sign-up")
  await page.getByLabel("Name").fill("Admin E2E")
  await page.getByLabel("Email").fill(adminEmail)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole("heading", { name: "Welcome to LyraShield" })).toBeVisible()
  await expect.poll(() => prisma.user.findUnique({ where: { email: adminEmail } })).not.toBeNull()
  await expect
    .poll(() =>
      prisma.account.count({
        where: {
          user: { email: adminEmail },
          providerId: "credential",
          issuer: "local:credential",
        },
      })
    )
    .toBe(1)
  await prisma.user.update({ where: { email: adminEmail }, data: { emailVerified: true } })

  // Credential sign-up may complete before its browser session is available to
  // page.request. Re-authenticate before using an authenticated API route.
  const initialSignOutResponse = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(initialSignOutResponse).toBeOK()
  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(adminEmail)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
  await expect(page.getByRole("heading", { name: "Welcome to LyraShield" })).toBeVisible()

  const onboardingResponse = await page.request.patch("/api/onboarding", {
    data: { skipped: true },
    headers: { "x-forwarded-for": forwardedFor },
  })
  await expect(onboardingResponse).toBeOK()

  await page.goto("/dashboard/settings")
  await page.getByLabel("Current password").fill(password)
  await page.getByRole("button", { name: "Set up authenticator" }).click()
  const setupUri = await page.getByLabel("Authenticator setup URI").inputValue()
  await page.getByLabel("Authenticator code").fill(totpFromUri(setupUri))
  await page.getByRole("button", { name: "Verify and enable" }).click()
  await expect(page.getByText("Authenticator verification is enabled")).toBeVisible()

  await expect(page.getByRole("link", { name: "Platform Admin" })).toHaveCount(0)
  const deniedResponse = await page.request.get("/api/admin/overview")
  expect(deniedResponse.status()).toBe(403)

  await prisma.user.update({
    where: { email: adminEmail },
    data: { platformRole: "PLATFORM_OPERATOR" },
  })
  const signOutResponse = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(signOutResponse).toBeOK()

  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(adminEmail)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/two-factor$/)
  await page.getByLabel("Authenticator code").fill(totpFromUri(setupUri))
  await page.getByRole("button", { name: "Verify and continue" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole("link", { name: "Platform Admin" })).toBeVisible()

  const overviewResponse = await page.request.get("/api/admin/overview")
  await expect(overviewResponse).toBeOK()
  expect(overviewResponse.headers()["cache-control"]).toContain("private")
  expect(overviewResponse.headers()["cache-control"]).toContain("no-store")

  const destinations = [
    ["/dashboard/admin", "Platform Admin"],
    ["/dashboard/admin/users", "Users"],
    ["/dashboard/admin/workspaces", "Workspaces"],
    ["/dashboard/admin/scans", "Scan operations"],
    ["/dashboard/admin/audit", "Admin audit"],
    ["/dashboard/admin/affiliates", "Affiliate Admin"],
  ] as const
  for (const [path, heading] of destinations) {
    await page.goto(path)
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Platform admin" })).toBeVisible()
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/dashboard/admin")
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)
  expect(browserErrors).toEqual([])
})
