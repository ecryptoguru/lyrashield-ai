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
