import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { genericOAuth, microsoftEntraId } from "better-auth/plugins"
import { prisma } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { env, isProd, isDev } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

const GITHUB_CLIENT_ID = env.GITHUB_CLIENT_ID
const GITHUB_CLIENT_SECRET = env.GITHUB_CLIENT_SECRET
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET
const AZURE_AD_CLIENT_ID = env.AZURE_AD_CLIENT_ID
const AZURE_AD_CLIENT_SECRET = env.AZURE_AD_CLIENT_SECRET
const AZURE_AD_TENANT_ID = env.AZURE_AD_TENANT_ID

// Origins allowed for auth/CSRF. Always includes BETTER_AUTH_URL; additional
// origins (staging, apex+www, preview deploys) come from a comma-separated
// ADDITIONAL_TRUSTED_ORIGINS env var so multi-origin deployments don't have
// their sign-in/OAuth requests rejected.
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
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: env.EMAIL_FROM || "noreply@lyrashield.ai" },
        to: [{ email: user.email, name: user.name }],
        subject: "Verify your email — LyraShield",
        htmlContent: `<p>Hi ${user.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")},</p><p>Click the link below to verify your email address:</p><p><a href="${url}">Verify Email</a></p><p>If you didn't create an account, you can safely ignore this email.</p>`,
      }),
    })
    if (!res.ok) {
      logger.error("Failed to send verification email via Brevo", {
        status: res.status,
        email: user.email,
      })
    }
  } else {
    logger.info("Email verification (dev mode — no email sent)", {
      email: user.email,
      verificationUrl: url,
    })
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
    requireEmailVerification: !isDev,
  },
  emailVerification: {
    sendVerificationEmail,
    sendOnSignUp: true,
  },
  socialProviders: {
    github: {
      clientId: GITHUB_CLIENT_ID ?? "",
      clientSecret: GITHUB_CLIENT_SECRET ?? "",
      enabled: !!GITHUB_CLIENT_ID,
    },
    google: {
      clientId: GOOGLE_CLIENT_ID ?? "",
      clientSecret: GOOGLE_CLIENT_SECRET ?? "",
      enabled: !!GOOGLE_CLIENT_ID,
    },
  },
  plugins: [
    genericOAuth({
      config: [
        microsoftEntraId({
          clientId: AZURE_AD_CLIENT_ID ?? "",
          clientSecret: AZURE_AD_CLIENT_SECRET ?? "",
          tenantId: AZURE_AD_TENANT_ID || "common",
          ...(AZURE_AD_CLIENT_ID ? {} : { disableSignUp: true }),
        }),
      ],
    }),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days (rolling)
    updateAge: 60 * 60 * 24, // 1 day (refresh interval)
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  advanced: {
    useSecureCookies: isProd,
    cookies: {
      session_token: {
        attributes: {
          sameSite: "lax",
          secure: isProd,
        },
      },
    },
  },
})

export type Auth = typeof auth
export type Session = typeof auth.$Infer.Session
export type User = typeof auth.$Infer.Session.user

export type { MemberRole }
