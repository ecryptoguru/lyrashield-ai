import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { bearer, deviceAuthorization, jwt, twoFactor } from "better-auth/plugins"
import { oauthProvider } from "@better-auth/oauth-provider"
import { consumePlatformAdminChallengeAttempt, getSystemPrisma, prisma } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { env, isProd, isDev } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { buildMicrosoftSocialProvider, isOAuthProviderConfigured } from "./oauth-providers"
import { activeWorkspaceIdFromCookie } from "./oauth-workspace"
import { resourcesMatch } from "./oauth-resource"
import { hasPermission, PERMISSIONS } from "./permissions"

const GITHUB_CLIENT_ID = env.GITHUB_CLIENT_ID
const GITHUB_CLIENT_SECRET = env.GITHUB_CLIENT_SECRET
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET
const AZURE_AD_CLIENT_ID = env.AZURE_AD_CLIENT_ID
const AZURE_AD_CLIENT_SECRET = env.AZURE_AD_CLIENT_SECRET
const AZURE_AD_TENANT_ID = env.AZURE_AD_TENANT_ID
const secureCookies = new URL(env.BETTER_AUTH_URL).protocol === "https:"
const githubEnabled = isOAuthProviderConfigured(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)
const googleEnabled = isOAuthProviderConfigured(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
const platformAdminEmails = new Set(env.PLATFORM_ADMIN_EMAILS.split(","))

export const OAUTH_WORKSPACE_CLAIM = "https://lyrashieldai.com/workspace_id"
export const OAUTH_SCOPE_READ = "lyrashield.read"
export const OAUTH_SCOPE_WRITE = "lyrashield.write"
export const OAUTH_RESOURCE = new URL("/api/mcp", env.NEXT_PUBLIC_APP_URL).toString()
export const OAUTH_ISSUER = new URL("/api/auth", env.BETTER_AUTH_URL).toString().replace(/\/$/, "")
const oauthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  OAUTH_SCOPE_READ,
  OAUTH_SCOPE_WRITE,
]

async function selectedOAuthWorkspaceId({
  userId,
  session,
  requestHeaders,
}: {
  userId: string
  session: Record<string, unknown>
  requestHeaders: Headers
}) {
  const candidates = [
    activeWorkspaceIdFromCookie(requestHeaders.get("cookie")),
    typeof session.activeWorkspaceId === "string" ? session.activeWorkspaceId : undefined,
  ].filter((workspaceId): workspaceId is string => Boolean(workspaceId))

  for (const workspaceId of new Set(candidates)) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { status: true },
    })
    if (member?.status === "active") return workspaceId
  }

  return undefined
}

const oauthProviderPlugin = oauthProvider({
  loginPage: "/sign-in",
  consentPage: "/oauth/consent",
  scopes: oauthScopes,
  validAudiences: [OAUTH_RESOURCE, env.NEXT_PUBLIC_APP_URL],
  resources: [
    {
      identifier: OAUTH_RESOURCE,
      name: "LyraShield MCP",
      allowedScopes: oauthScopes,
    },
  ],
  // There is one hosted resource. Existing and dynamically registered MCP
  // clients may request it without a separate administrative link step.
  enforcePerClientResources: false,
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  allowPublicClientPrelogin: true,
  // apps/web serves the required path-based issuer metadata route.
  silenceWarnings: { oauthAuthServerConfig: true },
  // Dynamic MCP clients must be allowed to request the approval-gated write
  // scope. This only permits a request; consent and the per-action gate remain required.
  clientRegistrationDefaultScopes: oauthScopes,
  clientRegistrationAllowedScopes: oauthScopes,
  postLogin: {
    page: "/oauth/select-workspace",
    shouldRedirect: async (context) => {
      const { user, session, scopes } = context
      const needsWorkspace = scopes.includes(OAUTH_SCOPE_READ) || scopes.includes(OAUTH_SCOPE_WRITE)
      if (!needsWorkspace || !session) return false
      const workspaceId = await selectedOAuthWorkspaceId({
        userId: user.id,
        session,
        requestHeaders: (context as unknown as { headers?: Headers }).headers ?? new Headers(),
      })
      return !workspaceId || session.userId !== user.id
    },
    consentReferenceId: async (context) => {
      const { user, session, scopes } = context
      const needsWorkspace = scopes.includes(OAUTH_SCOPE_READ) || scopes.includes(OAUTH_SCOPE_WRITE)
      if (!needsWorkspace || !session) return undefined
      const workspaceId = await selectedOAuthWorkspaceId({
        userId: user.id,
        session,
        requestHeaders: (context as unknown as { headers?: Headers }).headers ?? new Headers(),
      })
      if (!workspaceId) throw new Error("OAUTH_WORKSPACE_REQUIRED")
      return workspaceId
    },
  },
  customAccessTokenClaims: async ({ user, scopes, referenceId, resources }) => {
    if (!user || !referenceId || !resourcesMatch(resources, OAUTH_RESOURCE)) return {}

    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: referenceId, userId: user.id } },
      select: { role: true, status: true },
    })
    if (!member || member.status !== "active") throw new Error("OAUTH_WORKSPACE_ACCESS_REVOKED")
    if (scopes.includes(OAUTH_SCOPE_WRITE) && !hasPermission(member.role, PERMISSIONS.agent.act)) {
      throw new Error("OAUTH_WRITE_SCOPE_FORBIDDEN")
    }

    return {
      [OAUTH_WORKSPACE_CLAIM]: referenceId,
    }
  },
  advertisedMetadata: {
    scopes_supported: oauthScopes,
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "sid",
      "scope",
      "azp",
      OAUTH_WORKSPACE_CLAIM,
    ],
  },
})
/**
 * Verification is enforced when it is both asked for and actually deliverable.
 *
 * Previously this derived from BREVO_API_KEY alone, which made the operator's intent
 * unexpressible: LYRASHIELD_REQUIRE_EMAIL_VERIFICATION was declared but read nowhere, so
 * setting it had no effect and the absence of a mail key silently downgraded an openly
 * registerable app to unverified sign-up. The flag is now authoritative, defaults on, and
 * production config validation rejects "required but undeliverable".
 */
const emailVerificationRequested = env.LYRASHIELD_REQUIRE_EMAIL_VERIFICATION === "1"
const emailProviderConfigured = Boolean(env.BREVO_API_KEY)
const emailVerificationEnabled = emailVerificationRequested && emailProviderConfigured

if (emailVerificationRequested && !emailProviderConfigured) {
  logger.warn(
    "Email verification is requested but no mail provider is configured — sign-up will not be verified. " +
      "Set BREVO_API_KEY, or set LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 to make this explicit."
  )
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Origins allowed for auth/CSRF. Always includes BETTER_AUTH_URL; any origin
// added here may initiate credentialed auth requests. Marketing and Lite Check
// use separate route-scoped CORS policies and must not be trusted implicitly.
const trustedOrigins = [
  env.BETTER_AUTH_URL,
  ...(env.ADDITIONAL_TRUSTED_ORIGINS
    ? env.ADDITIONAL_TRUSTED_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : []),
]

async function sendVerificationEmail({
  user,
  url,
}: {
  user: { email: string; name: string }
  url: string
  token: string
}) {
  if (isProd && env.BREVO_API_KEY) {
    const apiKey = env.BREVO_API_KEY as string
    // Do not await the provider call — awaiting can leak timing information
    // about whether an email exists during sign-up/sign-in. The response is
    // processed in a detached promise and errors are logged asynchronously.
    void (async () => {
      try {
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "Content-Type": "application/json",
            "api-key": apiKey,
          },
          body: JSON.stringify({
            sender: { email: env.EMAIL_FROM || "noreply@lyrashieldai.com" },
            to: [{ email: user.email, name: user.name }],
            subject: "Verify your email — LyraShield",
            htmlContent: `<p>Hi ${escapeHtml(user.name)},</p><p>Click the link below to verify your email address:</p><p><a href="${escapeHtml(url)}">Verify Email</a></p><p>If you didn't create an account, you can safely ignore this email.</p>`,
          }),
        })
        if (!res.ok) {
          logger.error("Failed to send verification email via Brevo", {
            status: res.status,
          })
        }
      } catch (err) {
        logger.error("Exception while sending verification email", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  } else if (isProd && !env.BREVO_API_KEY) {
    logger.error("BREVO_API_KEY is required to send verification emails in production")
  } else {
    logger.info("Email verification not sent in development")
  }
}

async function sendResetPasswordEmail({
  user,
  url,
}: {
  user: { email: string; name: string }
  url: string
}) {
  if (isProd && env.BREVO_API_KEY) {
    const apiKey = env.BREVO_API_KEY as string
    void (async () => {
      try {
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "Content-Type": "application/json",
            "api-key": apiKey,
          },
          body: JSON.stringify({
            sender: { email: env.EMAIL_FROM || "noreply@lyrashieldai.com" },
            to: [{ email: user.email, name: user.name }],
            subject: "Reset your LyraShield password",
            htmlContent: `<p>Hi ${escapeHtml(user.name)},</p><p>Use the link below to reset your password. It expires in one hour.</p><p><a href="${escapeHtml(url)}">Reset password</a></p><p>If you did not request this, you can safely ignore this email.</p>`,
          }),
        })
        if (!res.ok) {
          logger.error("Failed to send reset email via Brevo", { status: res.status })
        }
      } catch (error) {
        logger.error("Exception while sending reset email", { error: String(error) })
      }
    })()
  } else if (isProd) {
    logger.error("BREVO_API_KEY is required to send password reset emails")
  } else {
    logger.info("Password reset email not sent in development")
  }
}

async function sendPlatformAdminSecurityAlert(subject: string, htmlContent: string): Promise<void> {
  if (!isProd) return
  if (!env.BREVO_API_KEY) throw new Error("BREVO_API_KEY is required for admin security alerts")
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", "api-key": env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: env.EMAIL_FROM || "noreply@lyrashieldai.com", name: "LyraShield AI" },
      to: [...platformAdminEmails].map((email) => ({ email })),
      subject,
      htmlContent,
    }),
  })
  if (!response.ok) throw new Error(`Admin recovery alert failed with status ${response.status}`)
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: emailVerificationEnabled,
    sendResetPassword: sendResetPasswordEmail,
    revokeSessionsOnPasswordReset: true,
  },
  ...(emailVerificationEnabled && !isDev
    ? {
        emailVerification: {
          sendVerificationEmail,
          sendOnSignUp: true,
          sendOnSignIn: true,
          autoSignInAfterVerification: true,
        },
      }
    : {}),
  socialProviders: {
    github: {
      clientId: GITHUB_CLIENT_ID ?? "",
      clientSecret: GITHUB_CLIENT_SECRET ?? "",
      enabled: githubEnabled,
      disableSignUp: false,
    },
    google: {
      clientId: GOOGLE_CLIENT_ID ?? "",
      clientSecret: GOOGLE_CLIENT_SECRET ?? "",
      enabled: googleEnabled,
      disableSignUp: false,
    },
    microsoft: buildMicrosoftSocialProvider(
      AZURE_AD_CLIENT_ID,
      AZURE_AD_CLIENT_SECRET,
      AZURE_AD_TENANT_ID
    ),
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (
        context.path !== "/two-factor/verify-totp" &&
        context.path !== "/two-factor/verify-backup-code"
      )
        return

      const currentSession = await getSessionFromCtx(context)
      let userId = currentSession?.user.id
      if (!userId) {
        const twoFactorCookie = context.context.createAuthCookie("two_factor")
        const challengeId = await context.getSignedCookie(
          twoFactorCookie.name,
          context.context.secret
        )
        const challenge = challengeId
          ? await context.context.internalAdapter.findVerificationValue(challengeId)
          : null
        userId = challenge?.value
      }
      if (!userId) {
        throw new APIError("UNAUTHORIZED", {
          code: "INVALID_TWO_FACTOR_CHALLENGE",
          message: "Two-factor challenge is invalid or expired",
        })
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          emailVerified: true,
          platformRole: true,
          twoFactorEnabled: true,
        },
      })
      const email = user?.email.trim().toLowerCase()
      const isPlatformAdmin = Boolean(
        user &&
        email &&
        platformAdminEmails.has(email) &&
        user.emailVerified &&
        user.platformRole === "PLATFORM_OPERATOR" &&
        user.twoFactorEnabled
      )
      if (!isPlatformAdmin) return

      const trustedIpHeader = env.TRUSTED_PROXY_IP_HEADER?.toLowerCase()
      const rawIp = trustedIpHeader ? context.headers?.get(trustedIpHeader) : null
      const ipAddress = rawIp?.split(",").at(-1)?.trim()
      if (!ipAddress) {
        throw new APIError("FORBIDDEN", {
          code: "ADMIN_CLIENT_IP_REQUIRED",
          message: "Administrator verification requires an authoritative client address",
        })
      }
      try {
        await consumePlatformAdminChallengeAttempt({ userId, ipAddress })
      } catch (error) {
        if (error instanceof Error && error.message === "ADMIN_CHALLENGE_RATE_LIMITED") {
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "ADMIN_CHALLENGE_RATE_LIMITED",
            message: "Too many administrator verification attempts",
          })
        }
        throw error
      }
    }),
    after: createAuthMiddleware(async (context) => {
      if (context.path === "/two-factor/disable") {
        const disabledSession = await getSessionFromCtx(context)
        if (!disabledSession) return
        const disabledUser = await prisma.user.findUnique({
          where: { id: disabledSession.user.id },
          select: { email: true, emailVerified: true, platformRole: true },
        })
        const disabledEmail = disabledUser?.email.trim().toLowerCase()
        if (
          !disabledUser ||
          !disabledEmail ||
          !platformAdminEmails.has(disabledEmail) ||
          !disabledUser.emailVerified ||
          disabledUser.platformRole !== "PLATFORM_OPERATOR"
        )
          return

        await getSystemPrisma().$transaction(async (tx) => {
          await tx.platformAdminElevation.deleteMany({ where: { userId: disabledSession.user.id } })
          await tx.session.deleteMany({ where: { userId: disabledSession.user.id } })
          await tx.platformAdminAudit.create({
            data: {
              actorUserId: disabledSession.user.id,
              sessionId: disabledSession.session.id,
              action: "platform_admin.mfa_disabled",
              resourceType: "user",
              resourceId: disabledSession.user.id,
            },
          })
        })
        await sendPlatformAdminSecurityAlert(
          "Platform administrator MFA disabled",
          "<p>Two-factor authentication was disabled for a LyraShield platform administrator.</p><p>All sessions and action elevations were revoked. Review the platform audit log immediately.</p>"
        )
        return
      }

      const isBackupRecovery = context.path === "/two-factor/verify-backup-code"
      if (context.path !== "/two-factor/verify-totp" && !isBackupRecovery) return

      const verifiedSession = context.context.newSession ?? context.context.session
      const returned = context.context.returned as
        { token?: unknown; user?: { id?: unknown } } | undefined
      const sessionToken = verifiedSession?.session.token ?? returned?.token
      const userId = verifiedSession?.user.id ?? returned?.user?.id
      if (typeof sessionToken !== "string" || typeof userId !== "string") return

      if (!isBackupRecovery) {
        await prisma.session.updateMany({
          where: { token: sessionToken, userId },
          data: { twoFactorVerifiedAt: new Date() },
        })
        return
      }

      const recoveryUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, emailVerified: true, platformRole: true, twoFactorEnabled: true },
      })
      const recoveryEmail = recoveryUser?.email.trim().toLowerCase()
      const isPlatformAdminRecovery = Boolean(
        recoveryUser &&
        recoveryEmail &&
        platformAdminEmails.has(recoveryEmail) &&
        recoveryUser.emailVerified &&
        recoveryUser.platformRole === "PLATFORM_OPERATOR" &&
        recoveryUser.twoFactorEnabled
      )
      if (!isPlatformAdminRecovery) {
        await prisma.session.updateMany({
          where: { token: sessionToken, userId },
          data: { twoFactorVerifiedAt: new Date() },
        })
        return
      }

      await sendPlatformAdminSecurityAlert(
        "Platform administrator recovery code used",
        "<p>A LyraShield platform administrator signed in with a one-time recovery code.</p><p>Review the platform audit log immediately if this was unexpected.</p>"
      )
      await getSystemPrisma().$transaction(async (tx) => {
        const session = await tx.session.findFirst({
          where: { token: sessionToken, userId },
          select: { id: true },
        })
        if (!session) throw new Error("ADMIN_RECOVERY_SESSION_NOT_FOUND")
        const stamped = await tx.session.updateMany({
          where: { id: session.id, userId },
          data: { twoFactorVerifiedAt: new Date() },
        })
        if (stamped.count !== 1) throw new Error("ADMIN_RECOVERY_SESSION_NOT_FOUND")
        await tx.platformAdminAudit.create({
          data: {
            actorUserId: userId,
            sessionId: session.id,
            action: "platform_admin.recovery_code_used",
            resourceType: "session",
            metadata: { administratorsNotified: true },
          },
        })
      })
    }),
  },
  plugins: [
    twoFactor({
      issuer: "LyraShield AI",
      skipVerificationOnEnable: false,
      trustDeviceMaxAge: 0,
      accountLockout: {
        enabled: true,
        maxFailedAttempts: 10,
        durationSeconds: 900,
      },
    }),
    jwt(),
    bearer(),
    deviceAuthorization({ verificationUri: "/device" }),
    oauthProviderPlugin,
  ],
  user: {
    additionalFields: {
      trialStartedAt: { type: "date", required: false, input: false, returned: false },
    },
  },
  session: {
    additionalFields: {
      activeWorkspaceId: { type: "string", required: false, input: true },
      twoFactorVerifiedAt: {
        type: "date",
        required: false,
        input: false,
        returned: false,
      },
    },
    expiresIn: 60 * 60 * 24 * 7, // 7 days (rolling)
    updateAge: 60 * 60 * 24, // 1 day (refresh interval)
    cookieCache: {
      // OAuth post-login selection updates this custom session field immediately.
      // The provider does not expose request headers to consentReferenceId, so a
      // cached session would otherwise bind the authorization to the prior workspace.
      enabled: false,
    },
  },
  advanced: {
    useSecureCookies: secureCookies,
    ...(env.BETTER_AUTH_COOKIE_DOMAIN
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: env.BETTER_AUTH_COOKIE_DOMAIN,
          },
        }
      : {}),
    cookies: {
      session_token: {
        attributes: {
          sameSite: "lax",
          secure: secureCookies,
        },
      },
    },
  },
})

export type Auth = typeof auth
export type Session = typeof auth.$Infer.Session
export type User = typeof auth.$Infer.Session.user

export type { MemberRole }
