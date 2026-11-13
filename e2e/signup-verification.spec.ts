import { expect, test, type Route } from "@playwright/test"

test.describe("verification-required signup", () => {
  for (const probe of ["pending", "failed"] as const) {
    test(`shows the verification next step when provider discovery is ${probe}`, async ({
      page,
    }) => {
      let pending: Route | undefined
      await page.route("**/api/auth/providers", (route) => {
        if (probe === "failed") return route.abort()
        pending = route
      })
      await page.route("**/api/auth/sign-up/email", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            token: null,
            user: { id: "fixture-verification-user", emailVerified: false },
          }),
        })
      )
      try {
        await page.goto("/sign-up")
        await page.getByLabel("Name", { exact: true }).fill("Verification fixture")
        await page.getByLabel("Email", { exact: true }).fill("verification@example.test")
        await page.locator("#password").fill("Fixture-password-123!")
        await page.getByRole("button", { name: "Create account" }).click()
        await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible()
        await expect(page.getByRole("button", { name: "Resend verification email" })).toBeEnabled()
        await expect(page.getByText("We sent a verification link", { exact: false })).toHaveCount(0)
        await expect(page.getByRole("link", { name: "Reset your password" })).toHaveAttribute(
          "href",
          "/forgot-password"
        )
        await expect(
          page.getByText("automatic sign-in did not complete", { exact: false })
        ).toHaveCount(0)
      } finally {
        await pending?.abort().catch(() => {})
      }
    })
  }
  test("recovers from a different signed-in account only after an explicit sign-out", async ({
    page,
  }) => {
    let signedOut = false
    await page.route("**/api/auth/providers", (route) => route.fulfill({ json: {} }))
    await page.route("**/api/auth/sign-up/email", (route) =>
      route.fulfill({
        json: { token: null, user: { id: "fixture", emailVerified: false } },
      })
    )
    await page.route("**/api/auth/sign-out", (route) => {
      signedOut = true
      return route.fulfill({ json: { success: true } })
    })
    await page.route("**/api/auth/send-verification-email", (route) =>
      route.fulfill(
        signedOut
          ? { json: { status: true } }
          : {
              status: 400,
              json: { message: "Email mismatch", code: "EMAIL_MISMATCH" },
            }
      )
    )
    await page.goto("/sign-up")
    await page.getByLabel("Name", { exact: true }).fill("Verification fixture")
    await page.getByLabel("Email", { exact: true }).fill("verification@example.test")
    await page.locator("#password").fill("Fixture-password-123!")
    await page.getByRole("button", { name: "Create account" }).click()
    await page.getByRole("button", { name: "Resend verification email" }).click()
    await expect(page.locator("p[role=alert]")).toContainText("signed in with a different email")
    expect(signedOut).toBe(false)
    await page.getByRole("button", { name: "Sign out and resend" }).click()
    await expect(page.locator("p[role=status]")).toContainText("If this address needs verification")
    await expect(page.getByRole("button", { name: /Resend in/ })).toBeDisabled()
    expect(signedOut).toBe(true)
  })
  for (const code of ["EMAIL_ALREADY_VERIFIED", "RATE_LIMITED"] as const) {
    test(`provides a usable next step for ${code}`, async ({ page }) => {
      await page.route("**/api/auth/providers", (route) => route.fulfill({ json: {} }))
      await page.route("**/api/auth/sign-up/email", (route) =>
        route.fulfill({
          json: { token: null, user: { id: "fixture", emailVerified: false } },
        })
      )
      await page.route("**/api/auth/send-verification-email", (route) =>
        route.fulfill({
          status: code === "RATE_LIMITED" ? 429 : 400,
          json: { code, message: "Fixture error" },
        })
      )
      await page.goto("/sign-up")
      await page.getByLabel("Name", { exact: true }).fill("Verification fixture")
      await page.getByLabel("Email", { exact: true }).fill("verification@example.test")
      await page.locator("#password").fill("Fixture-password-123!")
      await page.getByRole("button", { name: "Create account" }).click()
      await page.getByRole("button", { name: "Resend verification email" }).click()
      if (code === "EMAIL_ALREADY_VERIFIED") {
        await expect(page.locator("p[role=status]")).toContainText("already verified")
        await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible()
      } else {
        await expect(page.locator("p[role=alert]")).toContainText("Could not resend")
        await expect(page.locator("p[role=status]")).toHaveCount(0)
      }
      await expect(page.getByRole("button", { name: "Resend verification email" })).toBeEnabled()
      await expect(page.getByRole("button", { name: "Sign out and resend" })).toHaveCount(0)
    })
  }
})
