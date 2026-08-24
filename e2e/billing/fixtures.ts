import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test"
import { expect, request as playwrightRequest } from "@playwright/test"
import { deleteUserAccount, getSystemPrisma } from "@lyrashield/db"
import { assertSafeBillingE2EBaseUrl } from "./base-url-safety"

const DISPOSABLE_CONFIRMATION = "DELETE DISPOSABLE BILLING DATA"
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>
const prisma = getSystemPrisma()

export interface BillingActors {
  workspaceId: string
  workspaceName: string
  ownerEmail: string
  ownerUserId: string
  viewerEmail: string
  viewerUserId: string
  ownerStorageState: StorageState
  viewerStorageState: StorageState
  ownerRequest: APIRequestContext
  viewerRequest: APIRequestContext
  cleanup(): Promise<void>
}

function requireSafeBaseUrl(baseURL: string): void {
  const url = new URL(baseURL)
  const isRemote = url.hostname !== "127.0.0.1" && url.hostname !== "localhost"
  assertSafeBillingE2EBaseUrl(baseURL, process.env.BILLING_E2E_EXPECTED_BASE_HOST, isRemote)
}

async function createVerifiedSession(params: {
  browser: Browser
  baseURL: string
  email: string
  name: string
  password: string
  stagingAccessToken?: string
}): Promise<{ userId: string; storageState: StorageState }> {
  const context = await params.browser.newContext({
    baseURL: params.baseURL,
  })
  const page = await context.newPage()
  try {
    if (params.stagingAccessToken) {
      await page.goto("/staging/access")
      await page.getByLabel("Staging access code").fill(params.stagingAccessToken)
      await page.getByRole("button", { name: "Continue" }).click()
      await expect(page).toHaveURL(/\/sign-up$/)
    } else {
      await page.goto("/sign-up")
    }
    await page.getByLabel("Name").fill(params.name)
    await page.getByLabel("Email").fill(params.email)
    await page.locator("#password").fill(params.password)
    await page.getByRole("button", { name: "Create account" }).click()

    await expect
      .poll(() => prisma.user.findUnique({ where: { email: params.email } }))
      .not.toBeNull()
    const user = await prisma.user.findUniqueOrThrow({ where: { email: params.email } })
    await expect
      .poll(() =>
        prisma.account.count({
          where: { userId: user.id, providerId: "credential", issuer: "local:credential" },
        })
      )
      .toBe(1)
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } })

    const signOut = await page.request.post("/api/auth/sign-out", {
      data: {},
      headers: { Origin: params.baseURL },
    })
    expect(signOut.ok()).toBe(true)
    await page.goto("/sign-in")
    await page.getByLabel("Email").fill(params.email)
    await page.locator("#password").fill(params.password)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
    const onboarding = await page.request.patch("/api/onboarding", { data: { skipped: true } })
    expect(onboarding.ok()).toBe(true)
    const session = await page.request.get("/api/auth/get-session")
    expect(session.ok()).toBe(true)
    expect((await session.json()).user?.email).toBe(params.email)
    return { userId: user.id, storageState: await context.storageState() }
  } finally {
    await context.close()
  }
}

export async function provisionBillingActors(
  browser: Browser,
  baseURL: string
): Promise<BillingActors> {
  requireSafeBaseUrl(baseURL)
  if (process.env.BILLING_E2E_DISPOSABLE_CONFIRM !== DISPOSABLE_CONFIRMATION) {
    throw new Error(`Set BILLING_E2E_DISPOSABLE_CONFIRM="${DISPOSABLE_CONFIRMATION}"`)
  }
  const expectedDatabase = process.env.BILLING_E2E_EXPECTED_DATABASE?.trim()
  const expectedDatabaseHost = process.env.BILLING_E2E_EXPECTED_DATABASE_HOST?.trim()
  const evidenceDatabaseUrl = process.env.BILLING_E2E_DATABASE_URL?.trim()
  const fixtureBaseUrl = new URL(baseURL)
  const isRemote =
    fixtureBaseUrl.hostname !== "127.0.0.1" && fixtureBaseUrl.hostname !== "localhost"
  if (
    !process.env.DATABASE_URL ||
    !process.env.DATABASE_SYSTEM_URL ||
    !expectedDatabase ||
    !expectedDatabaseHost
  ) {
    throw new Error(
      "Disposable billing fixtures require both database URLs and exact database name/host guards"
    )
  }
  if (
    isRemote &&
    (!evidenceDatabaseUrl ||
      process.env.DATABASE_URL !== evidenceDatabaseUrl ||
      process.env.DATABASE_SYSTEM_URL !== evidenceDatabaseUrl)
  ) {
    throw new Error("Remote billing fixtures require the dedicated disposable E2E database role")
  }
  for (const value of [process.env.DATABASE_URL, process.env.DATABASE_SYSTEM_URL]) {
    if (new URL(value).hostname !== expectedDatabaseHost) {
      throw new Error("BILLING_E2E_EXPECTED_DATABASE_HOST does not match a database URL")
    }
  }
  const [database] = await prisma.$queryRaw<Array<{ current_database: string }>>`
    SELECT current_database()
  `
  if (!database || database.current_database !== expectedDatabase) {
    throw new Error("BILLING_E2E_EXPECTED_DATABASE does not match current_database()")
  }

  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const password = `Billing-${crypto.randomUUID()}-aA1!`
  const ownerEmail = `billing-owner-${suffix}@example.com`
  const viewerEmail = `billing-viewer-${suffix}@example.com`
  const workspaceName = `Billing E2E ${suffix}`
  const stagingAccessToken = process.env.BILLING_E2E_STAGING_ACCESS_TOKEN?.trim()

  let ownerRequest: APIRequestContext | null = null
  let viewerRequest: APIRequestContext | null = null
  let ownerUserId: string | null = null
  let viewerUserId: string | null = null
  let workspaceId: string | null = null
  let ownerStorageState: StorageState | null = null
  let viewerStorageState: StorageState | null = null

  try {
    const owner = await createVerifiedSession({
      browser,
      baseURL,
      email: ownerEmail,
      name: "Billing E2E Owner",
      password,
      stagingAccessToken,
    })
    ownerUserId = owner.userId
    ownerStorageState = owner.storageState
    ownerRequest = await playwrightRequest.newContext({
      baseURL,
      storageState: ownerStorageState,
    })

    const workspaceResponse = await ownerRequest.post("/api/workspaces", {
      data: { name: workspaceName, mode: "VIBE" },
    })
    if (!workspaceResponse.ok()) {
      throw new Error(`Disposable workspace creation failed: ${workspaceResponse.status()}`)
    }
    workspaceId = (await workspaceResponse.json()).data.id as string

    const viewer = await createVerifiedSession({
      browser,
      baseURL,
      email: viewerEmail,
      name: "Billing E2E Viewer",
      password,
      stagingAccessToken,
    })
    viewerUserId = viewer.userId
    viewerStorageState = viewer.storageState
    viewerRequest = await playwrightRequest.newContext({
      baseURL,
      storageState: viewerStorageState,
    })

    await prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId: viewerUserId,
        role: "VIEWER",
        status: "active",
      },
    })
    expect(
      await prisma.workspaceMember.count({
        where: { workspaceId, userId: ownerUserId, role: "OWNER", status: "active" },
      })
    ).toBe(1)
    expect(
      await prisma.workspaceMember.count({
        where: { workspaceId, userId: viewerUserId, role: "VIEWER", status: "active" },
      })
    ).toBe(1)

    const cleanup = async () => {
      const errors: unknown[] = []
      try {
        await ownerRequest?.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        await viewerRequest?.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        const licenses = await prisma.license.findMany({
          where: { workspaceId, ownerEmail },
          select: { id: true },
        })
        for (const license of licenses) {
          await prisma.license.delete({ where: { id: license.id } })
        }
      } catch (error) {
        errors.push(error)
      }
      try {
        if (viewerUserId) await deleteUserAccount(viewerUserId, "DELETE")
      } catch (error) {
        errors.push(error)
      }
      try {
        if (ownerUserId && workspaceId) await deleteUserAccount(ownerUserId, workspaceName)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Disposable billing fixture cleanup failed")
      }
    }

    return {
      workspaceId,
      workspaceName,
      ownerEmail,
      ownerUserId,
      viewerEmail,
      viewerUserId,
      ownerStorageState,
      viewerStorageState,
      ownerRequest,
      viewerRequest,
      cleanup,
    }
  } catch (error) {
    const cleanupErrors: unknown[] = []
    await Promise.allSettled([ownerRequest?.dispose(), viewerRequest?.dispose()])
    if (!viewerUserId) {
      viewerUserId = (await prisma.user.findUnique({ where: { email: viewerEmail } }))?.id ?? null
    }
    if (!ownerUserId) {
      ownerUserId = (await prisma.user.findUnique({ where: { email: ownerEmail } }))?.id ?? null
    }
    if (viewerUserId) {
      await deleteUserAccount(viewerUserId, "DELETE").catch((cleanupError: unknown) =>
        cleanupErrors.push(cleanupError)
      )
    }
    if (ownerUserId && workspaceId) {
      await deleteUserAccount(ownerUserId, workspaceName).catch((cleanupError: unknown) =>
        cleanupErrors.push(cleanupError)
      )
    } else if (ownerUserId) {
      await deleteUserAccount(ownerUserId, "DELETE").catch((cleanupError: unknown) =>
        cleanupErrors.push(cleanupError)
      )
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Fixture setup and cleanup failed")
    }
    throw error
  }
}

export async function expectViewerBillingDenied(
  request: APIRequestContext,
  workspaceId: string
): Promise<void> {
  const responses = await Promise.all([
    request.post("/billing/checkout", {
      data: { workspaceId, plan: "STARTER", interval: "monthly" },
    }),
    request.post("/api/billing/topup", { data: { workspaceId, pack: "pack_100" } }),
    request.get(`/api/billing/usage?workspaceId=${encodeURIComponent(workspaceId)}`),
    request.get(`/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`, {
      maxRedirects: 0,
    }),
  ])
  for (const response of responses) {
    if (response.status() !== 403) {
      throw new Error(`VIEWER billing request returned ${response.status()} instead of 403`)
    }
  }
}
