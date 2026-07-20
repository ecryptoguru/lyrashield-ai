import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { prisma } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { env, isProd } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { isBetaUserCreationAllowed } from "./beta-invites"
import { isOAuthProviderConfigured, socialSignUpEnabled } from "./oauth-providers"

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
const requireEmailVerification = env.LYRASHIELD_REQUIRE_EMAIL_VERIFICATION === "1"

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
    // Do not await the provider call — awaiting can leak timing information
    // about whether an email exists during sign-up/sign-in. The response is
    // processed in a detached promise and errors are logged asynchronously.
    void fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "api-key": env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: env.EMAIL_FROM || "noreply@lyrashieldai.com" },
        to: [{ email: user.email, name: user.name }],
        subject: "Verify your email — LyraShield",
        htmlContent: `<p>Hi ${user.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")},</p><p>Click the link below to verify your email address:</p><p><a href="${url}">Verify Email</a></p><p>If you didn't create an account, you can safely ignore this email.</p>`,
      }),
    })
      .then((res) => {
        if (!res.ok) {
          logger.error("Failed to send verification email via Brevo", {
            status: res.status,
          })
        }
      })
      .catch((err) => {
        logger.error("Exception while sending verification email", {
          error: err instanceof Error ? err.message : String(err),
        })
      })
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
    void fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "api-key": env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: env.EMAIL_FROM || "noreply@lyrashieldai.com" },
        to: [{ email: user.email, name: user.name }],
        subject: "Reset your LyraShield password",
        htmlContent: `<p>Hi ${user.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")},</p><p>Use the link below to reset your password. It expires in one hour.</p><p><a href="${url}">Reset password</a></p><p>If you did not request this, you can safely ignore this email.</p>`,
      }),
    })
      .then((res) => {
        if (!res.ok) logger.error("Failed to send reset email via Brevo", { status: res.status })
      })
      .catch((error) =>
        logger.error("Exception while sending reset email", { error: String(error) })
      )
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
    requireEmailVerification,
    sendResetPassword: sendResetPasswordEmail,
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.context.path !== "/sign-up/email" || !isProd) return
      const email = (ctx.body as { email?: unknown } | undefined)?.email
      if (
        typeof email !== "string" ||
        !isBetaUserCreationAllowed(isProd, email, env.LYRASHIELD_BETA_INVITE_EMAILS)
      ) {
        throw APIError.from("FORBIDDEN", {
          code: "BETA_INVITE_REQUIRED",
          message: "Beta access is by invitation.",
        })
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!isBetaUserCreationAllowed(isProd, user.email, env.LYRASHIELD_BETA_INVITE_EMAILS)) {
            throw APIError.from("FORBIDDEN", {
              code: "BETA_INVITE_REQUIRED",
              message: "Beta access is by invitation.",
            })
          }
          return { data: user }
        },
      },
    },
  },
  ...(requireEmailVerification
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
      // OAuth account creation is authorized by the production user.create
      // database hook, so only invited identities can be persisted.
      disableSignUp: !socialSignUpEnabled(isProd),
    },
    google: {
      clientId: GOOGLE_CLIENT_ID ?? "",
      clientSecret: GOOGLE_CLIENT_SECRET ?? "",
      enabled: googleEnabled,
      disableSignUp: !socialSignUpEnabled(isProd),
    },
    microsoft: {
      clientId: AZURE_AD_CLIENT_ID ?? "",
      clientSecret: AZURE_AD_CLIENT_SECRET ?? "",
      tenantId: AZURE_AD_TENANT_ID || "common",
      enabled: microsoftEnabled,
      prompt: "select_account",
      disableProfilePhoto: true,
      // Microsoft explicitly does not treat its mutable email claim as an
      // authorization boundary. Production users first create an invited
      // account and then link Microsoft from authenticated settings.
      disableSignUp: isProd,
    },
  },
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      allowDifferentEmails: false,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days (rolling)
    updateAge: 60 * 60 * 24, // 1 day (refresh interval)
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
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
