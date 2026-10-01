import { expect, test } from "@playwright/test"

test("agent onboarding distinguishes local setup and scoped hosted writes", async ({ page }) => {
  await page.goto("/agents")
  await expect(page).toHaveTitle(/coding agents/i)
  // The commands render in both the setup <pre> block and the numbered-step
  // inline <code> elements — first() avoids the strict-mode multiple match.
  await expect(page.getByText("npx --yes lyrashield@0.2.13 login --oauth").first()).toBeVisible()
  await expect(page.locator("main")).not.toContainText("init --dry-run")
  await expect(page.getByRole("heading", { name: "Configure published direct MCP" })).toBeVisible()
  await expect(
    page.getByText(
      /Manually merge the published @lyrashield\/mcp@0.2.11 server entry through the client guide/i
    )
  ).toBeVisible()
  await expect(
    page.locator("#setup").getByText(/browser-confirmed grant and execution-time checks/i)
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: /Set up LyraShield for your agent/i })
  ).toHaveAttribute("href", "/docs/integrations/agent-plugins")
})

test("mobile navigation reaches agent onboarding", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto("/")
  await page.getByRole("button", { name: "Open navigation menu" }).click()
  await page.getByRole("link", { name: "For agents" }).click()
  await expect(page).toHaveURL(/\/agents$/)
  await expect(
    page.getByRole("heading", { name: /Release assurance your coding agent can act on/i })
  ).toBeVisible()
})

// /agents.md and /llms.txt handler coverage lives in src/tests/agent-onboarding.test.ts.
// (direct GET-handler invocation): extensioned SSR endpoints self-redirect under
// `wrangler dev --local` — the assets layer normalizes `/agents.md` to
// `/agents.md/` and Astro's trailingSlash:"never" then 301s it back, looping.
// Production serves them correctly; the quirk is local-dev only.

test("manual plugin guides keep install, discovery and authentication separate", async ({
  page,
}) => {
  await page.goto("/docs/integrations/vscode-agent-plugin")
  await expect(page.getByRole("heading", { name: "Manual plugin instructions" })).toBeVisible()
  await expect(page.locator("main")).toContainText("MANUAL_REQUIRED")
  await expect(page.getByRole("link", { name: "manually configure VS Code MCP" })).toHaveAttribute(
    "href",
    "/docs/integrations/vscode"
  )
  await page.goto("/docs/integrations/github-copilot-cloud-agent")
  await expect(page.locator("main")).toContainText("Skill installation is withheld")
  await expect(page.locator("main")).not.toContainText("copy only")
  await expect(page.locator("main")).toContainText(".github/skills/")
  await expect(page.locator("main")).not.toContainText("enabledPlugins")
  await expect(page.locator("main")).not.toContainText("extraKnownMarketplaces")
  await expect(page.locator("main")).toContainText("connect_required")
})

test("Claude and Pi guides use current MCP setup while package releases remain pending", async ({
  page,
}) => {
  await page.goto("/docs/integrations/claude-code")
  await expect(page.getByRole("heading", { name: "Current guided setup" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Agent Plugin release pending" })).toBeVisible()
  await expect(page.locator("main")).not.toContainText("claude plugin marketplace add")
  await expect(page.locator("main")).toContainText("@lyrashield/mcp@0.2.11")
  await page.goto("/docs/integrations/pi")
  await expect(page.locator("main")).toContainText("predates native MCP support")
  await expect(page.locator("main")).toContainText("pi mcp login lyrashield")
  await expect(page.locator("main")).toContainText("pending release")
})

test("Copilot and Codex guides keep pending plugins out of current setup and HowTo metadata", async ({
  page,
}) => {
  for (const [slug, configPath] of [
    ["github-copilot", "~/.copilot/mcp-config.json"],
    ["openai-codex", "~/.codex/config.toml"],
    ["cursor", "~/.cursor/mcp.json"],
  ]) {
    await page.goto(`/docs/integrations/${slug}`)
    await expect(page.getByRole("heading", { name: "Agent Plugin release pending" })).toBeVisible()
    await expect(page.locator("main")).toContainText(configPath)
    await expect(page.locator("main")).toContainText("@lyrashield/mcp@0.2.11")
    await expect(page.locator("main")).toContainText("lyrashield@0.2.13 login --oauth")
    await expect(page.locator("main")).toContainText("lyrashield_list_workspaces")
    await expect(page.locator("main")).not.toContainText("plugin marketplace add")
    await expect(page.locator("main")).not.toContainText("lyrashield install")
    const metadata = await page.locator('script[type="application/ld+json"]').allTextContents()
    const howTo = metadata
      .flatMap((value) => JSON.parse(value))
      .find((item) => item["@type"] === "HowTo")
    expect(howTo).toBeDefined()
    expect(howTo.step).toHaveLength(4)
    expect(JSON.stringify(howTo)).toContain("@lyrashield/mcp@0.2.11")
    expect(JSON.stringify(howTo)).toContain("lyrashield@0.2.13 login --oauth")
    expect(JSON.stringify(howTo)).toContain("lyrashield_list_workspaces")
    expect(JSON.stringify(howTo)).not.toContain("marketplace")
  }
  await page.goto("/docs/integrations/agent-plugins")
  await expect(page.locator("main")).toContainText("Agent Plugin release pending")
  await expect(page.locator("main")).not.toContainText("install openai-codex")
  await expect(page.locator("main")).not.toContainText("install github-copilot")
  await expect(page.locator("main")).not.toContainText("install claude-code")
})

test("integration directory and public setup articles link to current pinned MCP guides", async ({
  page,
}) => {
  await page.goto("/docs/integrations")
  await expect(page.locator("main")).not.toContainText("init --dry-run")
  await expect(page.getByRole("heading", { name: "Agent Plugin release pending" })).toBeVisible()
  for (const slug of ["claude-code", "openai-codex", "github-copilot", "cursor"]) {
    const card = page.locator(`.nav-card[href="/docs/integrations/${slug}"]`).first()
    await expect(card).toContainText("Direct MCP setup")
    await expect(card).not.toContainText("Agent Plugin install")
  }
  const checkedGuides = new Set<string>()
  for (const [slug, guide] of [
    ["amp-app-security-checklist", "amp"],
    ["antigravity-mcp-security-workflow", "antigravity"],
    ["claude-code-mcp-agent-rules-security", "claude-code"],
    ["claude-code-security-workflow", "claude-code"],
    ["cline-app-security-checklist", "cline"],
    ["cline-mcp-security-workflow", "cline"],
    ["codebuff-mcp-security-workflow", "codebuff"],
    ["codex-mcp-security-workflow", "openai-codex"],
    ["codex-security-workflow", "openai-codex"],
    ["copilot-cli-mcp-security-workflow", "copilot-cli"],
    ["cursor-app-security-checklist", "cursor"],
    ["cursor-mcp-security-workflow", "cursor"],
    ["github-copilot-app-security-checklist", "github-copilot"],
    ["github-copilot-mcp-security-workflow", "github-copilot"],
    ["goose-app-security-checklist", "goose"],
    ["goose-mcp-security-workflow", "goose"],
    ["hermes-app-security-checklist", "hermes"],
    ["hermes-mcp-security-workflow", "hermes"],
    ["jetbrains-ai-app-security-checklist", "jetbrains"],
    ["jetbrains-mcp-security-workflow", "jetbrains"],
    ["kilo-code-app-security-checklist", "kilo-code"],
    ["kilo-code-mcp-security-workflow", "kilo-code"],
    ["kiro-mcp-security-workflow", "kiro"],
    ["kiro-app-security-checklist", "kiro"],
    ["devin-cli-mcp-security-workflow", "devin-cli"],
    ["mimo-code-app-security-checklist", "mimo-code"],
    ["mimo-code-mcp-security-workflow", "mimo-code"],
    ["oh-my-pi-app-security-checklist", "oh-my-pi"],
    ["oh-my-pi-mcp-security-workflow", "oh-my-pi"],
    ["openclaw-app-security-checklist", "openclaw"],
    ["openclaw-mcp-security-workflow", "openclaw"],
    ["opencode-app-security-checklist", "opencode"],
    ["opencode-mcp-security-workflow", "opencode"],
    ["pi-coding-agent-app-security-checklist", "pi"],
    ["pi-coding-agent-mcp-security-workflow", "pi"],
    ["roo-code-app-security-checklist", "roo-code"],
    ["roo-code-mcp-security-workflow", "roo-code"],
    ["vscode-ai-app-security-checklist", "vscode"],
    ["vscode-mcp-security-copilot", "vscode"],
    ["windsurf-security-workflow", "devin"],
  ]) {
    await page.goto(`/blog/${slug}`)
    const article = page.locator("article")
    await expect(article).toContainText("lyrashield@0.2.13 login --oauth")
    await expect(article).toContainText("@lyrashield/mcp@0.2.11")
    await expect(article).not.toContainText("one step install")
    await expect(article).not.toContainText("one-step install")
    await expect(article).not.toContainText("npx lyrashield")
    await expect(article.locator(`a[href="/docs/integrations/${guide}"]`).first()).toBeVisible()
    if (!checkedGuides.has(guide)) {
      expect((await page.request.get(`/docs/integrations/${guide}`)).status()).toBe(200)
      checkedGuides.add(guide)
    }
  }
})

test("Aider article keeps its repository check separate from native MCP", async ({ page }) => {
  await page.goto("/blog/aider-mcp-security-workflow")
  await expect(page.locator("article")).toContainText("lyrashield@0.2.13 login --oauth")
  await expect(page.locator("article")).not.toContainText("npx lyrashield")
  await expect(
    page.locator("article").locator('a[href="/docs/integrations/aider"]').first()
  ).toBeVisible()
  await page.goto("/blog/aider-app-security-checklist")
  const article = page.locator("article")
  await expect(article).toContainText("does not document native MCP client support")
  await expect(article).toContainText("lyrashield@0.2.13 check-diff")
  await expect(article).not.toContainText("npx lyrashield")
  await expect(article.locator('a[href="/docs/integrations/aider"]').first()).toBeVisible()
})
