import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

test("OAuth consent discloses automatic access and recovers from errors on mobile and desktop", async ({
  page,
}) => {
  const suffix = crypto.randomUUID()
  const email = `oauth-consent-${suffix}@example.com`
  const password = `${crypto.randomUUID()}-Aa1!`
  const headers = { Origin: "http://127.0.0.1:3100", "x-forwarded-for": "203.0.113.242" }
  await page.setExtraHTTPHeaders({ "x-forwarded-for": headers["x-forwarded-for"] })
  await expect(
    await page.request.post("/api/auth/sign-up/email", {
      data: { name: "Consent Tester", email, password },
      headers,
    })
  ).toBeOK()
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.request.post("/api/auth/sign-out", { data: {}, headers })
  await expect(
    await page.request.post("/api/auth/sign-in/email", {
      data: { email, password },
      headers,
    })
  ).toBeOK()
  await expect(
    await page.request.patch("/api/onboarding", {
      data: { skipped: true },
      headers,
    })
  ).toBeOK()
  const workspace = await page.request.post("/api/workspaces", {
    data: { name: `Consent ${suffix}`, mode: "VIBE" },
    headers,
  })
  await expect(workspace).toBeOK()
  const {
    data: { id: workspaceId },
  } = await workspace.json()

  // Exercise the actual rendered component and request contract without issuing
  // a real client grant or exchanging tokens from a fabricated OAuth request.
  await page.route("**/api/connections", async (route) => {
    const body = route.request().postDataJSON()
    expect(body).toMatchObject({
      workspaceId,
      allTargets: true,
      allowedTargetIds: [],
      scopes: ["lyrashield.read", "lyrashield.write"],
    })
    expect(body.allowedOperations).toHaveLength(5)
    expect(body.allowedProfiles).toEqual(["SAFE", "QUICK", "STANDARD", "DEEP", "CUSTOM"])
    await route.fulfill({
      status: 503,
      json: { error: { message: "Connection unavailable. Try again." } },
    })
  })
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(
      "/oauth/consent?client_id=local-render-fixture&client_name=Test%20Agent&scope=lyrashield.read%20lyrashield.write"
    )
    await expect(page.getByRole("heading", { name: "Connect Test Agent" })).toBeVisible()
    await page.getByLabel("Target Workspace").selectOption(workspaceId)
    await expect(page.getByText(/incur charges/)).toBeVisible()
    await expect(page.getByRole("checkbox")).toHaveCount(0)
    await expect(page.getByRole("radio")).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
    const connect = page.getByRole("button", { name: "Connect LyraShield", exact: true })
    await connect.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "Connection unavailable. Try again."
    )
    await expect(connect).toBeEnabled()
  }
  await page.goto("/oauth/consent?client_id=local-render-fixture&scope=lyrashield.read")
  await expect(page.getByText(/cannot make changes/)).toBeVisible()
  await expect(page.getByText("Automatic workspace access")).toHaveCount(0)
  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  for (const role of ["VIEWER", "AUDITOR"] as const) {
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      data: { role },
    })
    await expect(
      await page.request.post("/api/reports", {
        data: { workspaceId, title: `${role} automatic local acceptance`, type: "developer" },
        headers,
      })
    ).toBeOK()
    await expect(await page.request.get(`/api/connections?workspaceId=${workspaceId}`)).toBeOK()
    const keyResponse = await page.request.post("/api/api-keys", {
      data: { workspaceId, name: "must-not-create", scopes: ["read", "write"] },
      headers,
    })
    expect(keyResponse.status()).toBe(403)
  }
  await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    data: { status: "inactive" },
  })
  expect(
    (
      await page.request.post("/api/reports", {
        data: { workspaceId, title: "must-not-create-after-removal", type: "developer" },
        headers,
      })
    ).status()
  ).toBe(403)
})
