import { expect, test } from "@playwright/test"

const VULNERABLE_TS = `
import OpenAI from "openai"
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function ask(userInput: string) {
  return openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: userInput }],
  })
}
`

test.describe("AI App Security scanner tool", () => {
  test("loads the tool page and shows local privacy promise", async ({ page }) => {
    await page.goto("/tools/ai-app-security-scanner")
    await expect(page).toHaveTitle(/AI App Security Scanner/)
    await expect(page.getByText(/Runs entirely in this browser/)).toBeVisible()
  })

  test("scans pasted code entirely in the browser with no network request", async ({ page }) => {
    await page.goto("/tools/ai-app-security-scanner")
    await page.getByRole("tab", { name: "Paste code" }).click()
    await page.locator("#ai-app-paste").fill(VULNERABLE_TS)

    const networkRequests: string[] = []
    page.on("request", (request) => {
      const url = request.url()
      if (!url.startsWith("data:") && !url.includes(".svg") && !url.includes(".css")) {
        networkRequests.push(url)
      }
    })

    await page.locator("#ai-app-run").click()

    await expect(page.getByText("DETECTED").first()).toBeVisible()
    await expect(page.getByText("AI-01")).toBeVisible()
    await expect(page.getByText("Create account and scan the complete repository")).toBeVisible()
    expect(
      networkRequests.filter((url) => !url.includes("localhost") && !url.includes("127.0.0.1"))
    ).toHaveLength(0)
  })

  test("keyboard navigates tabs and runs the scan", async ({ page, isMobile }) => {
    test.skip(isMobile, "Mobile WebKit has no hardware Tab key")
    await page.goto("/tools/ai-app-security-scanner")
    await page.locator("#ai-app-files-tab").focus()
    await expect(page.locator("#ai-app-files-tab")).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.locator("#ai-app-paste-tab")).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.locator("#ai-app-paste-panel")).not.toHaveClass(/hidden/)
  })

  test("mobile layout keeps the scan button and output visible", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto("/tools/ai-app-security-scanner")
    await expect(page.locator("#ai-app-run")).toBeVisible()
    await expect(page.locator("#ai-app-result")).toBeVisible()
  })
})
