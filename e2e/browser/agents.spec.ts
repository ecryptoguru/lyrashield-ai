import { expect, test, type Page } from "@playwright/test"
import { CLI_PACKAGE_SPEC, MCP_PACKAGE_SPEC } from "../../packages/agent-registry/src/versions"

const harnessUrl = "?agents"

async function openAgents(page: Page) {
  await page.goto(harnessUrl)
}

test("agent cards group client surfaces and update setup material with selection", async ({
  page,
}) => {
  await openAgents(page)

  const jetbrains = page.getByRole("group", { name: "JetBrains" })
  await expect(jetbrains).toHaveCount(1)
  const surface = jetbrains.getByRole("combobox", { name: "Choose JetBrains client surface" })
  await surface.focus()
  await expect(surface).toBeFocused()
  await surface.selectOption("junie-cli")

  await expect(jetbrains).toContainText(".junie/mcp/mcp.json")
  await expect(jetbrains.getByRole("link", { name: "Set up" })).toHaveAttribute(
    "href",
    "/dashboard/agents/junie-cli"
  )
  await expect(jetbrains.getByRole("link", { name: "Docs" })).toHaveAttribute(
    "href",
    "https://lyrashieldai.com/docs/integrations/junie-cli"
  )
  await expect(jetbrains).toContainText(
    "No installer for this surface in the published LyraShield CLI"
  )
  await expect(jetbrains.getByLabel("Published install command")).toHaveCount(0)

  await surface.selectOption("jetbrains")
  await expect(jetbrains.getByRole("link", { name: "Set up" })).toHaveAttribute(
    "href",
    "/dashboard/agents/jetbrains"
  )

  const claude = page.getByRole("group", { name: "Claude" })
  const claudeSurface = claude.getByRole("combobox", { name: "Choose Claude client surface" })
  await claudeSurface.selectOption("claude-code-agent-plugin")
  await expect(claude).toContainText("Manual Agent Plugin setup")
  await expect(claude.getByLabel("Published install command")).toHaveCount(0)
  await claude.getByText("Manual setup notes", { exact: true }).click()
  await expect(claude).toContainText("reviewed matching immutable package release")
  await expect(claude.getByRole("link", { name: "Set up" })).toHaveAttribute(
    "href",
    "/dashboard/agents/claude-code-agent-plugin"
  )

  await claudeSurface.selectOption("claude-web")
  await expect(claude).toContainText("Managed inside the agent UI")
  await expect(claude.getByLabel("Published install command")).toHaveCount(0)
  await expect(claude.getByRole("link", { name: "Docs" })).toHaveAttribute(
    "href",
    "https://lyrashieldai.com/docs/integrations/claude-web"
  )
})

test("agent search and strategy filters preserve focused empty states", async ({ page }) => {
  await openAgents(page)
  const search = page.getByRole("searchbox", { name: "Search coding agents" })
  const strategy = page.getByRole("combobox", { name: "Filter by setup strategy" })

  await strategy.selectOption("agent-plugin")
  await search.fill("Claude")
  const claude = page.getByRole("group", { name: "Claude" })
  await expect(claude).toHaveCount(1)
  await expect(claude).toContainText("Agent Plugin")

  await search.fill("no-such-agent-surface")
  await expect(page.getByRole("status")).toContainText(
    "No coding agents match this search or strategy."
  )

  await search.fill("")
  await strategy.selectOption("all")
  await expect(page.getByRole("group", { name: "JetBrains" })).toHaveCount(1)
})

test("agent card copy reports success and failure accessibly", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    })
  })
  await openAgents(page)
  const copyButton = page.getByRole("button", { name: /^Copy install command for / }).first()
  await expect(copyButton).toBeVisible()
  await copyButton.click()
  await expect(
    page.locator('[role="status"][aria-live="polite"]').filter({ hasText: "Copied to clipboard." })
  ).toHaveCount(1)

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    })
    document.execCommand = () => false
  })
  await page.reload()
  const failingCopy = page.getByRole("button", { name: /^Copy install command for / }).first()
  await failingCopy.click()
  await expect(page.getByRole("alert")).toContainText("Copy failed")
})

test("a delayed copy result is ignored after switching client surfaces", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            window.addEventListener("resolve-delayed-clipboard", () => resolve(), { once: true })
            window.dispatchEvent(new Event("delayed-clipboard-pending"))
          }),
      },
    })
  })
  await page.goto("?agents=copy-race")

  const card = page.getByRole("group", { name: "Copy Race" })
  const surface = card.getByRole("combobox", { name: "Choose Copy Race client surface" })
  await surface.selectOption("copy-race-ide")

  const clipboardPending = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.addEventListener("delayed-clipboard-pending", () => resolve(), { once: true })
      })
  )
  await card.getByRole("button", { name: "Copy install command for Copy Race IDE" }).click()
  await clipboardPending
  await surface.selectOption("copy-race-cli")
  const newSurfaceCopy = card.getByRole("button", {
    name: "Copy install command for Copy Race CLI",
  })
  await expect(newSurfaceCopy).toBeVisible()
  await page.evaluate(async () => {
    window.dispatchEvent(new Event("resolve-delayed-clipboard"))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  })

  await expect(newSurfaceCopy).toBeVisible()
  await expect(card.getByRole("button", { name: /Copy Race CLI: copied/ })).toHaveCount(0)
  await expect(card.locator('[role="status"][aria-live="polite"]')).toHaveText("")
})

test("agent grid fits desktop and mobile viewports without horizontal overflow", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport)
    await openAgents(page)
    await expect(page.getByRole("heading", { name: "Coding Agents" })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`agents-${viewport.width}px.png`),
    })
  }

  expect(consoleErrors).toEqual([])
})

test("Pi setup exposes the documented OAuth command and accessible copy success", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    })
  })

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto("?agent-wizard=picode")
    await expect(page.getByRole("heading", { name: "Set up Pi" })).toBeVisible()
    await expect(page.getByText("pi mcp login lyrashield", { exact: true })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`pi-wizard-${viewport.width}px.png`),
    })
  }

  await page.getByRole("button", { name: "Copy Pi OAuth login command" }).click()
  await expect(page.getByRole("status")).toContainText("Copied to clipboard.")
  expect(consoleErrors).toEqual([])
})

test("Claude Code optional hooks stay collapsed until requested and announce copy failures", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    })
    document.execCommand = () => false
  })
  await page.goto("?agent-wizard=claude-code-agent-plugin")

  const optionalHooks = page
    .locator("details")
    .filter({ hasText: "Optional: advisory pre-commit check" })
  await expect(optionalHooks).toHaveCount(1)
  await expect(optionalHooks).not.toHaveJSProperty("open", true)
  await optionalHooks.locator("summary").click()
  await expect(optionalHooks).toHaveJSProperty("open", true)
  await expect(optionalHooks).toContainText("Off by default")
  await expect(optionalHooks).toContainText("never starts a paid scan")
  await expect(optionalHooks).toContainText("preserves unrelated hook commands")
  await expect(
    optionalHooks.getByRole("button", { name: "Copy optional hook install command" })
  ).toHaveCount(1)
  await page.getByRole("button", { name: "Copy doctor command" }).click()
  await expect(page.getByRole("alert")).toContainText("Copy failed")
})

test("hosted Lovable setup omits local CLI doctor and hooks", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("?agent-wizard=lovable")

  await expect(page.getByRole("heading", { name: "Set up Lovable" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Copy doctor command" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Copy hook install command" })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)
})

test("Copilot Cloud Agent uses a private read-only secret and no local commands", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto("?agent-wizard=github-copilot-cloud-agent")
    await expect(
      page.getByRole("heading", { name: "Set up GitHub Copilot Cloud Agent" })
    ).toBeVisible()
    await expect(page.getByText("COPILOT_MCP_LYRASHIELD_API_KEY", { exact: false })).toBeVisible()
    await expect(page.getByText("connect_required", { exact: false }).first()).toBeVisible()
    await expect(
      page.getByRole("button", { name: /doctor command|hook install command|login command/i })
    ).toHaveCount(0)
    await expect(page.getByText(/npx -y/i)).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`copilot-cloud-wizard-${viewport.width}px.png`),
    })
  }

  expect(consoleErrors).toEqual([])
})

for (const width of [375, 1280]) {
  test(`VS Code manual plugin setup and MCP fallback stay honest at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 812 })
    await openAgents(page)
    const card = page.getByRole("group", { name: "GitHub Copilot", exact: true })
    await card
      .getByRole("combobox", { name: "Choose GitHub Copilot client surface" })
      .selectOption("vscode-agent-plugin")
    await expect(card).toContainText("Manual Agent Plugin setup")
    await expect(card.getByLabel("Published install command")).toHaveCount(0)
    await card.getByText("Manual setup notes", { exact: true }).click()
    await expect(card).toContainText("MANUAL_REQUIRED")
    await expect(card).toContainText(".vscode/mcp.json")
    await expect(card).not.toContainText("global: ~/.lyrashield/plugins/lyrashield")
    await page.goto("?agent-wizard=vscode-agent-plugin")
    await expect(page.getByRole("heading", { name: "Manual Agent Plugin setup" })).toBeVisible()
    const fallback = page.locator("ol li").filter({ hasText: "Current direct MCP fallback" })
    await expect(fallback).toHaveCount(1)
    await expect(fallback).toContainText(".vscode/mcp.json")
    await expect(fallback).toContainText(MCP_PACKAGE_SPEC)
    await expect(
      page.locator("ol li").filter({ has: page.getByRole("heading", { name: "Authenticate" }) })
    ).toContainText(`${CLI_PACKAGE_SPEC} login --oauth`)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
    expect(overflow).toBe(false)
    await page.screenshot({
      path: testInfo.outputPath(`vscode-manual-wizard-${width}px.png`),
      fullPage: true,
    })
  })
}
