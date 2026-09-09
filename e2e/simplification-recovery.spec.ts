import { expect, test } from "@playwright/test"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"

test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--enable-experimental-web-platform-features", "--enable-blink-features=WebMCP"],
  },
})

test("connection recovery, concurrent onboarding and native WebMCP", async ({
  page,
  context,
  browser,
}) => {
  const suffix = crypto.randomUUID()
  const email = `recovery-${suffix}@example.invalid`
  const password = `${crypto.randomUUID()}-Aa1!`
  const headers = { Origin: "http://127.0.0.1:3100", "x-forwarded-for": "203.0.113.244" }
  await page.setExtraHTTPHeaders({ "x-forwarded-for": headers["x-forwarded-for"] })
  await expect(
    await page.request.post("/api/auth/sign-up/email", {
      data: { name: "Recovery Tester", email, password },
      headers,
    })
  ).toBeOK()
  const user = await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.request.post("/api/auth/sign-out", { data: {}, headers })
  await expect(
    await page.request.post("/api/auth/sign-in/email", { data: { email, password }, headers })
  ).toBeOK()
  const workspaceResponse = await page.request.post("/api/workspaces", {
    data: { name: `Recovery ${suffix}`, mode: "VIBE" },
    headers,
  })
  await expect(workspaceResponse).toBeOK()
  const {
    data: { id: workspaceId },
  } = await workspaceResponse.json()
  const second = await context.newPage()
  try {
    const state = (await (await page.request.get("/api/onboarding")).json()).data
    const first = await page.request.patch("/api/onboarding", {
      data: { workspaceId, currentStep: 2, expectedUpdatedAt: state.updatedAt },
      headers,
    })
    await expect(first).toBeOK()
    const stale = await second.request.patch("/api/onboarding", {
      data: { currentStep: 1, expectedUpdatedAt: state.updatedAt },
      headers,
    })
    expect(stale.status()).toBe(409)
    // Controlled GitHub responses exercise UI recovery without a provider mutation.
    let releaseSlow!: () => void
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let repoCalls = 0
    await page.route("**/api/integrations/github/repos?*", async (route) => {
      const call = ++repoCalls
      if (call === 1) await slow
      await route.fulfill({
        status: call === 2 ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          call === 2
            ? {
                success: false,
                error: { code: "NOT_CONNECTED", message: "GitHub installation was revoked" },
              }
            : { success: true, data: [] }
        ),
      })
    })
    await page.goto("/onboarding")
    await expect.poll(() => repoCalls).toBe(1)
    await page.getByRole("button", { name: "Load repositories" }).click()
    await expect(page.getByRole("alert").filter({ hasText: "revoked" })).toBeVisible()
    releaseSlow()
    await page.getByRole("button", { name: "Load repositories" }).click()
    await expect(page.getByText("No repositories are available.", { exact: false })).toBeVisible()
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()
    await page.reload()
    await expect(page.getByRole("heading", { name: "Select a repository" })).toBeVisible()
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Add your first target" })).toBeVisible()
    await page.unroute("**/api/integrations/github/repos?*")
    await page.request.patch("/api/onboarding", { data: { skipped: true }, headers })

    const connection = await prisma.agentConnection.create({
      data: {
        workspaceId,
        userId: user.id,
        clientType: "test",
        clientName: "Recovery client",
        scopes: ["lyrashield.read", "lyrashield.write"],
        status: "PAUSED",
      },
    })
    await prisma.agentOperation.create({
      data: {
        workspaceId,
        connectionId: connection.id,
        principalType: "OAUTH_CONNECTION",
        principalId: connection.id,
        operationName: "report.create",
        idempotencyKey: suffix,
        inputHash: suffix,
        status: "COMPLETED",
      },
    })
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto("/dashboard/connections")
      await expect(page.getByText("Access unavailable", { exact: false })).toBeVisible()
      await expect(page.getByText(/Last used/)).toBeVisible()
      await page.screenshot({ path: `/tmp/lyrashield-connections-${width}.png`, fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )
    }
    await page.getByRole("button", { name: "Resume", exact: true }).click()
    await expect(page.getByText("Reads and writes available", { exact: false })).toBeVisible()
    await page.getByRole("button", { name: "Disconnect", exact: true }).click()
    await expect(page.getByText(/Reconnect from your coding agent/)).toBeVisible()

    const target = await prisma.target.create({
      data: { workspaceId, name: "Native probe", type: "WEB_APP", url: "https://example.invalid" },
    })
    await page.goto("/dashboard/scans")
    const available = await page.evaluate(() => typeof document.modelContext !== "undefined")
    expect(available, `Native WebMCP unavailable in ${browser.version()}`).toBe(true)
    await expect
      .poll(() =>
        page.evaluate(async () => (await document.modelContext.getTools()).map((tool) => tool.name))
      )
      .toContain("request_security_scan")
    const names = await page.evaluate(async () =>
      (await document.modelContext.getTools()).map((tool) => tool.name)
    )
    expect(names).toContain("prepare_security_scan")
    expect(names).toContain("request_security_scan")
    const prepared = await page.evaluate(async () => {
      const tool = (await document.modelContext.getTools()).find(
        (tool) => tool.name === "prepare_security_scan"
      )!
      return document.modelContext.executeTool(tool, JSON.stringify({ targetName: "Native probe" }))
    })
    expect(JSON.stringify(prepared)).toContain("Native probe")
    expect(await prisma.scan.count({ where: { workspaceId } })).toBe(0)
    await prisma.onboardingState.update({
      where: { userId: user.id },
      data: { workspaceId, targetId: target.id, currentStep: 3, skipped: false },
    })
    await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.update({ where: { id: target.id, workspaceId }, data: { deletedAt: new Date() } })
    )
    await second.goto("/onboarding")
    await expect(second.getByRole("heading", { name: "Add your first target" })).toBeVisible()
    const deletedTargetState = await prisma.onboardingState.findUniqueOrThrow({
      where: { userId: user.id },
    })
    expect(deletedTargetState.workspaceId).toBe(workspaceId)
    expect(deletedTargetState.targetId).toBeNull()
    await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.update({ where: { id: target.id, workspaceId }, data: { deletedAt: null } })
    )
    await prisma.onboardingState.update({
      where: { userId: user.id },
      data: { targetId: target.id, currentStep: 3 },
    })
    // Native execution with permission loss reaches the server and creates no scan.
    await prisma.workspaceMember.updateMany({
      where: { workspaceId, userId: user.id },
      data: { status: "inactive" },
    })
    const rejected = await page.evaluate(async () => {
      const tool = (await document.modelContext.getTools()).find(
        (tool) => tool.name === "request_security_scan"
      )!
      return document.modelContext.executeTool(
        tool,
        JSON.stringify({ targetName: "Native probe", requestId: "permission-loss-test" })
      )
    })
    expect(JSON.stringify(rejected)).toMatch(/error|forbidden|access|permission/i)
    expect(await prisma.scan.count({ where: { workspaceId, targetId: target.id } })).toBe(0)
    await second.goto("/onboarding")
    await expect(second.getByRole("heading", { name: "Add your first target" })).toBeVisible()
    const recovered = await prisma.onboardingState.findUniqueOrThrow({ where: { userId: user.id } })
    expect(recovered.workspaceId).toBeNull()
    expect(recovered.targetId).toBeNull()
    expect(recovered.currentStep).toBe(0)
    console.info("Native WebMCP browser:", browser.version())
    await test.info().attach("native-browser", {
      body: JSON.stringify({ version: browser.version(), names, prepared, rejected }),
      contentType: "application/json",
    })
  } finally {
    await second.close()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { deletedAt: new Date() } })
  }
})
