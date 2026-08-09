import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import {
  bearer,
  deviceAuthorization,
  genericOAuth,
  jwt,
  microsoftEntraId,
} from "better-auth/plugins"
import { oauthProvider } from "@better-auth/oauth-provider"
import { prisma } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { env, isProd, isDev } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { isOAuthProviderConfigured } from "./oauth-providers"
import { activeWorkspaceIdFromCookie } from "./oauth-workspace"
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
const microsoftEnabled = isOAuthProviderConfigured(AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET)

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
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  allowPublicClientPrelogin: true,
  clientRegistrationDefaultScopes: oauthScopes.slice(0, 5),
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
  customAccessTokenClaims: async ({ user, scopes, referenceId, resource }) => {
    if (!user || !referenceId || (resource && resource !== OAUTH_RESOURCE)) return {}

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
  },
  plugins: [
    jwt(),
    bearer(),
    deviceAuthorization({ verificationUri: "/device" }),
    oauthProviderPlugin,
    ...(microsoftEnabled
      ? [
          genericOAuth({
            config: [
              microsoftEntraId({
                clientId: AZURE_AD_CLIENT_ID ?? "",
                clientSecret: AZURE_AD_CLIENT_SECRET ?? "",
                tenantId: AZURE_AD_TENANT_ID || "common",
                disableSignUp: false,
              }),
            ],
          }),
        ]
      : []),
  ],
  session: {
    additionalFields: {
      activeWorkspaceId: { type: "string", required: false, input: true },
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
