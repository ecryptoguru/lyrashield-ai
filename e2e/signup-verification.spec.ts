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
        await expect(
          page.getByText("automatic sign-in did not complete", { exact: false })
        ).toHaveCount(0)
      } finally {
        await pending?.abort().catch(() => {})
      }
    })
  }
})
