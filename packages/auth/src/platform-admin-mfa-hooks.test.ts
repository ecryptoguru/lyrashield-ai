import { beforeEach, describe, expect, it, vi } from "vitest"

const captured = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }))
const getSessionFromCtx = vi.hoisted(() => vi.fn())
const userFindUnique = vi.hoisted(() => vi.fn())
const sessionUpdateMany = vi.hoisted(() => vi.fn())
const consumePlatformAdminChallengeAttempt = vi.hoisted(() => vi.fn())
const systemTransaction = vi.hoisted(() => vi.fn())
const systemSessionFindFirst = vi.hoisted(() => vi.fn())
const systemSessionUpdateMany = vi.hoisted(() => vi.fn())
const platformAuditCreate = vi.hoisted(() => vi.fn())
const systemElevationDeleteMany = vi.hoisted(() => vi.fn())
const systemSessionDeleteMany = vi.hoisted(() => vi.fn())

vi.mock("better-auth", () => ({
  betterAuth: vi.fn((options) => {
    captured.options = options
    return { options }
  }),
}))
vi.mock("better-auth/api", () => ({
  APIError: class APIError extends Error {
    status: string
    body: unknown
    constructor(status: string, body: { message: string }) {
      super(body.message)
      this.status = status
      this.body = body
    }
  },
  createAuthMiddleware: vi.fn((handler) => handler),
  getSessionFromCtx,
}))
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: vi.fn(() => ({})) }))
vi.mock("better-auth/plugins", () => ({
  bearer: vi.fn(() => ({})),
  deviceAuthorization: vi.fn(() => ({})),
  jwt: vi.fn(() => ({})),
  twoFactor: vi.fn(() => ({})),
}))
vi.mock("@better-auth/oauth-provider", () => ({ oauthProvider: vi.fn(() => ({})) }))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
    session: { updateMany: (...args: unknown[]) => sessionUpdateMany(...args) },
  },
  consumePlatformAdminChallengeAttempt: (...args: unknown[]) =>
    consumePlatformAdminChallengeAttempt(...args),
  getSystemPrisma: () => ({ $transaction: systemTransaction }),
}))
vi.mock("@lyrashield/config", () => ({
  env: {
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    AZURE_AD_CLIENT_ID: "",
    AZURE_AD_CLIENT_SECRET: "",
    AZURE_AD_TENANT_ID: "",
    BETTER_AUTH_URL: "https://app.lyrashieldai.com",
    NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
    BETTER_AUTH_SECRET: "x".repeat(32),
    LYRASHIELD_REQUIRE_EMAIL_VERIFICATION: "0",
    PLATFORM_ADMIN_EMAILS: "ecryptoguru@gmail.com,ankit@lyrashieldai.com",
    TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
  },
  isProd: false,
  isDev: true,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("./oauth-providers", () => ({
  buildMicrosoftSocialProvider: vi.fn(() => ({ enabled: false })),
  isOAuthProviderConfigured: vi.fn(() => false),
}))
vi.mock("./oauth-workspace", () => ({ activeWorkspaceIdFromCookie: vi.fn() }))
vi.mock("./oauth-resource", () => ({ resourcesMatch: vi.fn(() => false) }))
vi.mock("./permissions", () => ({
  hasPermission: vi.fn(() => false),
  PERMISSIONS: { agent: { act: "agent:act" } },
}))

import "./auth"

type HookContext = {
  path: string
  headers: Headers
  getSignedCookie: ReturnType<typeof vi.fn>
  context: {
    secret: string
    createAuthCookie: ReturnType<typeof vi.fn>
    internalAdapter: { findVerificationValue: ReturnType<typeof vi.fn> }
    newSession: null
    session: null
    returned?: unknown
  }
}

function hooks() {
  return (captured.options?.hooks ?? {}) as {
    before: (context: HookContext) => Promise<void>
    after: (context: HookContext) => Promise<void>
  }
}

function context(headers = new Headers({ "x-forwarded-for": "198.51.100.1, 203.0.113.10" })) {
  const hookContext: HookContext = {
    path: "/two-factor/verify-totp",
    headers,
    getSignedCookie: vi.fn().mockResolvedValue("signed-challenge"),
    context: {
      secret: "secret",
      createAuthCookie: vi.fn(() => ({ name: "better-auth.two_factor" })),
      internalAdapter: {
        findVerificationValue: vi.fn().mockResolvedValue({ value: "admin-1" }),
      },
      newSession: null,
      session: null,
    },
  }
  return hookContext
}

describe("platform admin Better Auth TOTP hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionFromCtx.mockResolvedValue(null)
    systemSessionFindFirst.mockResolvedValue({ id: "session-1" })
    systemSessionUpdateMany.mockResolvedValue({ count: 1 })
    systemTransaction.mockImplementation((callback) =>
      callback({
        session: {
          findFirst: systemSessionFindFirst,
          updateMany: systemSessionUpdateMany,
          deleteMany: systemSessionDeleteMany,
        },
        platformAdminElevation: { deleteMany: systemElevationDeleteMany },
        platformAdminAudit: { create: platformAuditCreate },
      })
    )
    userFindUnique.mockResolvedValue({
      email: "ankit@lyrashieldai.com",
      emailVerified: true,
      platformRole: "PLATFORM_OPERATOR",
      twoFactorEnabled: true,
    })
  })

  it("revokes existing sessions after a password reset", () => {
    expect(captured.options?.emailAndPassword).toMatchObject({
      revokeSessionsOnPasswordReset: true,
    })
  })

  it("limits direct TOTP endpoint attempts by resolved user and authoritative IP", async () => {
    await hooks().before(context())

    expect(consumePlatformAdminChallengeAttempt).toHaveBeenCalledWith({
      userId: "admin-1",
      ipAddress: "203.0.113.10",
    })
  })

  it("fails closed for an eligible admin when authoritative IP is unavailable", async () => {
    await expect(hooks().before(context(new Headers()))).rejects.toThrow(
      "Administrator verification requires an authoritative client address"
    )
    expect(consumePlatformAdminChallengeAttempt).not.toHaveBeenCalled()
  })

  it("stamps only the exact session returned by successful TOTP verification", async () => {
    const hookContext = context()
    hookContext.context.returned = { token: "s1", user: { id: "admin-1" } }

    await hooks().after(hookContext)

    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { token: "s1", userId: "admin-1" },
      data: { twoFactorVerifiedAt: expect.any(Date) },
    })
  })

  it("rate-limits and atomically audits administrator backup-code recovery", async () => {
    const hookContext = context()
    hookContext.path = "/two-factor/verify-backup-code"
    hookContext.context.returned = { token: "s1", user: { id: "admin-1" } }

    await hooks().before(hookContext)
    await hooks().after(hookContext)

    expect(consumePlatformAdminChallengeAttempt).toHaveBeenCalledWith({
      userId: "admin-1",
      ipAddress: "203.0.113.10",
    })
    expect(systemSessionFindFirst).toHaveBeenCalledWith({
      where: { token: "s1", userId: "admin-1" },
      select: { id: true },
    })
    expect(systemSessionUpdateMany).toHaveBeenCalledWith({
      where: { id: "session-1", userId: "admin-1" },
      data: { twoFactorVerifiedAt: expect.any(Date) },
    })
    expect(platformAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "platform_admin.recovery_code_used",
          sessionId: "session-1",
        }),
      })
    )
  })

  it("revokes all sessions and elevations when an administrator disables MFA", async () => {
    const hookContext = context()
    hookContext.path = "/two-factor/disable"
    getSessionFromCtx.mockResolvedValue({
      user: { id: "admin-1" },
      session: { id: "session-1" },
    })

    await hooks().after(hookContext)

    expect(systemElevationDeleteMany).toHaveBeenCalledWith({ where: { userId: "admin-1" } })
    expect(systemSessionDeleteMany).toHaveBeenCalledWith({ where: { userId: "admin-1" } })
    expect(platformAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "platform_admin.mfa_disabled" }),
      })
    )
  })
})
