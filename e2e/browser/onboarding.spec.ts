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
        if (path === "/api/onboarding/workspace" && route.request().method() === "GET") {
          await route.fulfill({ json: { success: true, data: [] } })
        } else if (path === "/api/onboarding/workspace" && route.request().method() === "POST") {
          workspaceCalls++
          await workspaceHeld
          await route.fulfill({
            json: {
              success: true,
              data: {
                state: { ...state, workspaceId: "ws-browser" },
                workspace: { id: "ws-browser", name: "Mine", role: "OWNER", canManageGitHub: true },
                trialStarted: false,
              },
            },
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
      await expect(page.getByRole("button", { name: "Use workspace", exact: true })).toBeDisabled()
      await page.getByLabel("Workspace", { exact: true }).selectOption("create")
      await page.getByLabel("Workspace name", { exact: true }).fill("Mine")
      await page.getByRole("button", { name: "Use workspace", exact: true }).click()
      await expect(page.getByLabel("Workspace name", { exact: true })).toBeDisabled()
      expect(workspaceCalls).toBe(1)
      releaseWorkspace()
      await page.getByLabel("URL", { exact: true }).fill("https://example.com")
      await page.getByLabel("I own or am authorized to scan this target.").check()
      await page.getByRole("button", { name: "Continue", exact: true }).click()
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

for (const width of [390, 1440]) {
  test(`explicitly selects the second eligible workspace at ${width}px`, async ({
    page,
  }, testInfo) => {
    const selections: unknown[] = []
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("**/api/**", async (route) => {
      expect(new URL(route.request().url()).pathname).toBe("/api/onboarding/workspace")
      const input = route.request().postDataJSON()
      selections.push(input)
      await route.fulfill({
        json: {
          success: true,
          data: {
            state: {
              currentStep: 1,
              completed: false,
              skipped: false,
              workspaceId: "ws-selected",
              targetId: null,
              selectedGoal: null,
              updatedAt: "2026-10-30T00:00:00.001Z",
            },
            workspace: {
              id: "ws-selected",
              name: "Beta",
              role: "DEVELOPER",
              canManageGitHub: false,
            },
            trialStarted: false,
          },
        },
      })
    })
    await page.setViewportSize({ width, height: 844 })
    await page.goto("?onboarding=url")
    await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("")
    await expect(page.getByRole("option", { name: "Alpha · OWNER" })).toHaveCount(1)
    await expect(page.getByRole("option", { name: "Beta · DEVELOPER" })).toHaveCount(1)
    expect(selections).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`workspace-chooser-${width}px.png`) })
    await page.getByLabel("Workspace", { exact: true }).selectOption("ws-selected")
    await page.getByRole("button", { name: "Use workspace", exact: true }).click()
    await expect(page.getByLabel("URL", { exact: true })).toBeVisible()
    expect(selections).toEqual([
      { kind: "select", workspaceId: "ws-selected", expectedUpdatedAt: "2026-10-09T00:00:00.000Z" },
    ])
    expect(errors).toEqual([])
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
  })
}

test("recovers changed access without choosing another membership or losing an entered name", async ({
  page,
}) => {
  const selections: unknown[] = []
  await page.route("**/api/onboarding/workspace", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { success: true, data: [{ id: "ws-first", name: "Alpha", role: "OWNER" }] },
      })
    selections.push(route.request().postDataJSON())
    return route.fulfill({
      status: selections.length === 1 ? 403 : 500,
      json: {
        success: false,
        error: {
          code: selections.length === 1 ? "WORKSPACE_UNAVAILABLE" : "INTERNAL_ERROR",
          message:
            selections.length === 1 ? "Choose another workspace or create one." : "Please retry.",
        },
      },
    })
  })
  await page.goto("?onboarding=url")
  await page.getByLabel("Workspace", { exact: true }).selectOption("ws-selected")
  await page.getByRole("button", { name: "Use workspace", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Choose another workspace")
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("ws-selected")
  await expect(page.getByRole("button", { name: "Use workspace", exact: true })).toBeDisabled()
  expect(selections).toHaveLength(1)
  await page.getByLabel("Workspace", { exact: true }).selectOption("create")
  await page.getByLabel("Workspace name", { exact: true }).fill("Keep this input")
  await page.getByRole("button", { name: "Use workspace", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Please retry")
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("Keep this input")
  expect(selections).toHaveLength(2)
})

test("skips without creating a workspace or claiming a trial", async ({ page }) => {
  const requests: string[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/**", async (route) => {
    requests.push(new URL(route.request().url()).pathname)
    await held
    await route.fulfill({
      json: {
        success: true,
        data: {
          currentStep: 0,
          completed: false,
          skipped: true,
          workspaceId: null,
          targetId: null,
          selectedGoal: null,
          updatedAt: "2026-10-30T00:00:00.000Z",
        },
      },
    })
  })
  await page.goto("?onboarding=url")
  await page.getByRole("button", { name: "Skip / finish later", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Skip / finish later", exact: true })
  ).toBeDisabled()
  expect(requests).toEqual(["/api/onboarding"])
  release()
})

for (const width of [390, 1440]) {
  test(`recovered deleted target stays cleared through a build-context save at ${width}px`, async ({
    page,
  }) => {
    // Next inlines public analytics env; this portable Vite fixture supplies an empty one.
    await page.addInitScript(() => Object.defineProperty(window, "process", { value: { env: {} } }))
    let stored = {
      currentStep: 3,
      completed: false,
      skipped: false,
      workspaceId: "ws-selected",
      targetId: "deleted-target" as string | null,
      selectedGoal: null,
      updatedAt: "2026-10-09T00:00:00.000Z",
    }
    const targets: unknown[] = []
    const scans: unknown[] = []
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === "/api/onboarding") {
        const { expectedUpdatedAt, ...updates } = route.request().postDataJSON()
        if (expectedUpdatedAt !== stored.updatedAt)
          return route.fulfill({
            status: 409,
            json: {
              success: false,
              error: { code: "ONBOARDING_CHANGED", message: "Setup changed in another tab." },
            },
          })
        stored = {
          ...stored,
          ...updates,
          updatedAt: new Date(Date.parse(stored.updatedAt) + 1).toISOString(),
        }
        return route.fulfill({ json: { success: true, data: stored } })
      }
      if (path === "/api/targets") {
        targets.push(route.request().postDataJSON())
        return route.fulfill({ json: { success: true, data: { id: "replacement-target" } } })
      }
      if (path === "/api/scans" && route.request().method() === "POST") {
        scans.push(route.request().postDataJSON())
        return route.fulfill({ json: { success: true, data: { id: "replacement-scan" } } })
      }
      if (path === "/api/scans/eligibility")
        return route.fulfill({
          json: {
            success: true,
            data: {
              allowed: true,
              code: null,
              message: null,
              plan: "TRIAL",
              isTrial: true,
              remainingMinutes: 60,
            },
          },
        })
      return route.fulfill({
        status: 500,
        json: { success: false, error: { code: "UNEXPECTED_REQUEST", message: path } },
      })
    })
    await page.setViewportSize({ width, height: 844 })
    await page.goto("?onboarding=url&onboarding-recovery=1")
    await page.getByLabel("URL", { exact: true }).fill("https://replacement.example.test")
    await page.getByLabel("I own or am authorized to scan this target.").check()
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await page.getByRole("button", { name: "Cursor", exact: true }).click()
    await page.getByRole("button", { name: /Add an app URL/ }).click()
    await expect(page.getByLabel("URL", { exact: true })).toHaveValue(
      "https://replacement.example.test"
    )
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    await page.getByRole("button", { name: "Start surface review", exact: true }).click()
    await expect(page.getByRole("link", { name: /View scan/ })).toBeVisible()
    expect(targets).toEqual([
      expect.objectContaining({
        workspaceId: "ws-selected",
        url: "https://replacement.example.test",
      }),
    ])
    expect(scans).toEqual([
      expect.objectContaining({ workspaceId: "ws-selected", targetId: "replacement-target" }),
    ])
    expect(stored.targetId).toBe("replacement-target")
  })
}
