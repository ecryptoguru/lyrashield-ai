import { z } from "zod"

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL connection URL"),
  DATABASE_DIRECT_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("")),

  // Redis (redis:// URL — reserved for the BullMQ job queue, Sprint 4+)
  REDIS_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("")),

  // Upstash Redis REST (HTTP) — distributed rate limiting in production.
  // These are the HTTPS REST endpoint + token, NOT the redis:// REDIS_URL above.
  UPSTASH_REDIS_REST_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("")),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional().or(z.literal("")),

  // Better Auth
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
  // Comma-separated extra origins trusted for auth/CSRF (staging, apex+www,
  // preview deploys). BETTER_AUTH_URL is always trusted; these are appended.
  ADDITIONAL_TRUSTED_ORIGINS: z.string().optional().or(z.literal("")),

  // GitHub OAuth
  GITHUB_CLIENT_ID: z.string().optional().or(z.literal("")),
  GITHUB_CLIENT_SECRET: z.string().optional().or(z.literal("")),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional().or(z.literal("")),
  GOOGLE_CLIENT_SECRET: z.string().optional().or(z.literal("")),

  // Microsoft Entra ID (Azure AD) OAuth
  AZURE_AD_CLIENT_ID: z.string().optional().or(z.literal("")),
  AZURE_AD_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  AZURE_AD_TENANT_ID: z.string().optional().or(z.literal("")),

  // GitHub App (Sprint 3)
  GITHUB_APP_ID: z.string().optional().or(z.literal("")),
  // App slug (from the GitHub App settings URL) — used to build the public
  // installation URL `https://github.com/apps/{slug}/installations/new`.
  GITHUB_APP_SLUG: z.string().optional().or(z.literal("")),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine(
      (val) => !val || val.includes("-----BEGIN"),
      "GITHUB_APP_PRIVATE_KEY must be a PEM-formatted key starting with '-----BEGIN'"
    ),
  GITHUB_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),

  // App
  NEXT_PUBLIC_APP_URL: z.string().url("NEXT_PUBLIC_APP_URL must be a valid URL"),

  // Scan Engine (Sprint 5+)
  LYRASHIELD_LLM: z.string().optional().or(z.literal("")),
  LLM_API_KEY: z.string().optional().or(z.literal("")),
  LYRASHIELD_IMAGE: z.string().optional().or(z.literal("")),
  LYRASHIELD_ENGINE_PATH: z.string().optional().or(z.literal("")),

  // Evidence Storage
  S3_ENDPOINT: z.string().optional().or(z.literal("")),
  S3_ACCESS_KEY: z.string().optional().or(z.literal("")),
  S3_SECRET_KEY: z.string().optional().or(z.literal("")),
  S3_BUCKET: z.string().optional().or(z.literal("")),
  S3_REGION: z.string().optional().or(z.literal("")),

  // Email (Brevo)
  BREVO_API_KEY: z.string().optional().or(z.literal("")),
  EMAIL_FROM: z.string().optional().or(z.literal("")),

  // Billing (Sprint 10)
  POLAR_ACCESS_TOKEN: z.string().optional().or(z.literal("")),
  POLAR_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  RAZORPAY_KEY_ID: z.string().optional().or(z.literal("")),
  RAZORPAY_KEY_SECRET: z.string().optional().or(z.literal("")),

  // Monitoring
  SENTRY_DSN: z.string().optional().or(z.literal("")),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().or(z.literal("")),

  // Runtime
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
}).refine(
  // If an Upstash REST URL is configured, a token must accompany it — a URL
  // without a token silently falls back to per-instance in-memory limiting.
  (val) => !(val.UPSTASH_REDIS_REST_URL && !val.UPSTASH_REDIS_REST_TOKEN),
  {
    path: ["UPSTASH_REDIS_REST_TOKEN"],
    message: "UPSTASH_REDIS_REST_TOKEN is required when UPSTASH_REDIS_REST_URL is set",
  }
)

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    console.error(
      `\n❌ Invalid environment variables:\n${issues}\n\n` +
        `Please fix the variables in your .env file.\n`
    )
    throw new Error("Invalid environment configuration. See errors above.")
  }

  return parsed.data
}

export const env = loadEnv()

export const isProd = env.NODE_ENV === "production"
export const isDev = env.NODE_ENV === "development"
export const isTest = env.NODE_ENV === "test"
