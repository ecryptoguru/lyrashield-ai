import { expect, test } from "@playwright/test"

for (const width of [390, 1440]) {
  for (const hint of ["url", "api"]) {
    test(`fresh ${hint} onboarding shows workspace preparation and advances at ${width}px`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      let releaseWorkspace!: () => void
      const workspaceHeld = new Promise<void>((resolve) => {
        releaseWorkspace = resolve
      })
      let workspaceCalls = 0
      const state = {
        currentStep: 1,
        completed: false,
        skipped: false,
        workspaceId: null as string | null,
        targetId: null,
        selectedGoal: null,
        updatedAt: "2026-10-09T00:00:00.000Z",
      }
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname
        if (path === "/api/workspaces") {
          workspaceCalls++
          await workspaceHeld
          await route.fulfill({
            json: { success: true, data: { id: "ws-browser", trialStarted: false } },
          })
        } else if (path === "/api/onboarding") {
          Object.assign(state, route.request().postDataJSON())
          await route.fulfill({ json: { success: true, data: state } })
        } else {
          await route.fulfill({
            status: 500,
            json: {
              success: false,
              error: { code: "UNEXPECTED_REQUEST", message: "Unexpected test request." },
            },
          })
        }
      })
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`?onboarding=${hint}`)
      await page.getByLabel("URL", { exact: true }).fill("https://example.com")
      await page.getByLabel("I own or am authorized to scan this target.").check()
      await page.getByRole("button", { name: "Continue", exact: true }).click()
      await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled()
      await expect(page.getByLabel("URL", { exact: true })).toBeDisabled()
      await expect(
        page.getByRole("button", { name: "Skip / finish later", exact: true })
      ).toBeDisabled()
      expect(workspaceCalls).toBe(1)
      releaseWorkspace()
      await expect(
        page.getByRole("button", {
          name: hint === "api" ? "Start endpoint review" : "Start surface review",
          exact: true,
        })
      ).toBeEnabled()
      await expect(page.getByRole("alert")).toHaveCount(0)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`onboarding-${hint}-${width}px.png`) })
      expect(errors).toEqual([])
    })
  }
}
