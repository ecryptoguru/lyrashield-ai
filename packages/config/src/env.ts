import { z } from "zod"

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL connection URL"),
  DATABASE_DIRECT_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("")),

  // Redis
  REDIS_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal("")),

  // Better Auth
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),

  // GitHub OAuth
  GITHUB_CLIENT_ID: z.string().optional().or(z.literal("")),
  GITHUB_CLIENT_SECRET: z.string().optional().or(z.literal("")),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional().or(z.literal("")),
  GOOGLE_CLIENT_SECRET: z.string().optional().or(z.literal("")),

  // GitHub App (Sprint 3)
  GITHUB_APP_ID: z.string().optional().or(z.literal("")),
  GITHUB_APP_PRIVATE_KEY: z.string().optional().or(z.literal("")),
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
})

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
