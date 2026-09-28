import { expect, test } from "@playwright/test"

test("enforces the static script policy while the theme initializes", async ({ page }) => {
  const violations: string[] = []
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`)
    })
  })
  page.on("console", (message) => {
    if (message.text().startsWith("CSP violation:")) violations.push(message.text())
  })

  const response = await page.goto("/")
  const csp = response?.headers()["content-security-policy"] ?? ""
  expect(csp).toContain("script-src 'self'")
  expect(csp.split("; ").find((directive) => directive.startsWith("script-src "))).not.toContain(
    "'unsafe-inline'"
  )
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system")
  expect(violations).toEqual([])
})
