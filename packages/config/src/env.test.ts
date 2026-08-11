import { describe, it, expect } from "vitest"
import { z } from "zod"

// Test the Zod schema directly without importing the module
// (which calls loadEnv() at import time and would throw)
const envSchema = z
  .object({
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL connection URL"),
    DATABASE_DIRECT_URL: z.string().url().optional().or(z.literal("")),
    DATABASE_SYSTEM_URL: z.string().url().optional().or(z.literal("")),
    REDIS_URL: z.string().url().optional().or(z.literal("")),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
    GITHUB_CLIENT_ID: z.string().optional().or(z.literal("")),
    GITHUB_CLIENT_SECRET: z.string().optional().or(z.literal("")),
    GOOGLE_CLIENT_ID: z.string().optional().or(z.literal("")),
    GOOGLE_CLIENT_SECRET: z.string().optional().or(z.literal("")),
    GITHUB_APP_ID: z.string().optional().or(z.literal("")),
    GITHUB_APP_PRIVATE_KEY: z.string().optional().or(z.literal("")),
    GITHUB_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
    NEXT_PUBLIC_APP_URL: z.string().url("NEXT_PUBLIC_APP_URL must be a valid URL"),
    TRUSTED_PROXY_IP_HEADER: z.string().optional().or(z.literal("")),
    LYRASHIELD_LLM: z.string().optional().or(z.literal("")),
    LYRASHIELD_LUNA_LLM: z.string().optional().or(z.literal("")),
    LYRASHIELD_TERRA_LLM: z.string().optional().or(z.literal("")),
    LLM_API_KEY: z.string().optional().or(z.literal("")),
    LYRASHIELD_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
    LYRASHIELD_MAX_INPUT_TOKENS: z.coerce.number().int().positive().optional(),
    LYRASHIELD_PROMPT_CACHE_EXPLICIT: z.enum(["0", "1"]).optional().default("1"),
    LYRASHIELD_PROMPT_CACHE: z.enum(["0", "1"]).optional().default("1"),
    LYRASHIELD_IMAGE: z.string().optional().or(z.literal("")),
    LYRASHIELD_ENGINE_PATH: z.string().optional().or(z.literal("")),
    LYRASHIELD_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(3).default(1),
    // Web Search (Parallel Search)
    LYRASHIELD_WEB_SEARCH_ENABLED: z.enum(["0", "1"]).optional().default("0"),
    LYRASHIELD_WEB_SEARCH_API_KEY: z.string().optional().or(z.literal("")),
    LYRASHIELD_WEB_SEARCH_PROVIDER: z.string().optional().or(z.literal("")),
    LYRASHIELD_WEB_SEARCH_MODE: z.enum(["turbo", "basic", "advanced"]).optional().or(z.literal("")),
    LYRASHIELD_WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(20).optional(),
    LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL: z.coerce.number().int().min(1000).max(20000).optional(),
    LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN: z.coerce.number().int().min(0).optional(),
    LYRASHIELD_WEB_SEARCH_BUDGET_USD: z.coerce.number().min(0).optional(),
    S3_ENDPOINT: z.string().optional().or(z.literal("")),
    S3_ACCESS_KEY: z.string().optional().or(z.literal("")),
    S3_SECRET_KEY: z.string().optional().or(z.literal("")),
    S3_BUCKET: z.string().optional().or(z.literal("")),
    S3_REGION: z.string().optional().or(z.literal("")),
    BREVO_API_KEY: z.string().optional().or(z.literal("")),
    EMAIL_FROM: z.string().optional().or(z.literal("")),
    SLACK_WEBHOOK_URL: z.string().optional().or(z.literal("")),
    DISCORD_WEBHOOK_URL: z.string().optional().or(z.literal("")),
    NOTIFICATION_FROM_EMAIL: z.string().optional().or(z.literal("")),
    POLAR_ACCESS_TOKEN: z.string().optional().or(z.literal("")),
    POLAR_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
    RAZORPAY_KEY_ID: z.string().optional().or(z.literal("")),
    RAZORPAY_KEY_SECRET: z.string().optional().or(z.literal("")),
    SENTRY_DSN: z.string().optional().or(z.literal("")),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional().or(z.literal("")),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .refine((val) => val.NODE_ENV !== "production" || Boolean(val.TRUSTED_PROXY_IP_HEADER), {
    path: ["TRUSTED_PROXY_IP_HEADER"],
    message:
      "TRUSTED_PROXY_IP_HEADER is required in production or rate limiting degrades to a single global bucket",
  })
  .refine(
    (val) =>
      val.NODE_ENV !== "production" ||
      /^ghcr\.io\/ecryptoguru\/lyrashield-sandbox@sha256:[a-f0-9]{64}$/.test(val.LYRASHIELD_IMAGE),
    {
      path: ["LYRASHIELD_IMAGE"],
      message: "LYRASHIELD_IMAGE must be a LyraShield-owned immutable sha256 digest in production",
    }
  )
  .refine(
    (val) =>
      val.LYRASHIELD_WEB_SEARCH_ENABLED !== "1" || Boolean(val.LYRASHIELD_WEB_SEARCH_API_KEY),
    {
      path: ["LYRASHIELD_WEB_SEARCH_API_KEY"],
      message: "LYRASHIELD_WEB_SEARCH_API_KEY is required when LYRASHIELD_WEB_SEARCH_ENABLED=1",
    }
  )

const validEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
}

describe("Env Validation Schema", () => {
  describe("valid env", () => {
    it("should parse with all required fields present", () => {
      const result = envSchema.safeParse(validEnv)
      expect(result.success).toBe(true)
    })

    it("should parse with optional fields omitted", () => {
      const result = envSchema.safeParse(validEnv)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.GITHUB_CLIENT_ID).toBeUndefined()
        expect(result.data.BREVO_API_KEY).toBeUndefined()
      }
    })

    it("should default NODE_ENV to development", () => {
      const result = envSchema.safeParse(validEnv)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.NODE_ENV).toBe("development")
      }
    })

    it("should accept NODE_ENV as production with a trusted proxy header", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        NODE_ENV: "production",
        TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
        LYRASHIELD_IMAGE: `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"a".repeat(64)}`,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.NODE_ENV).toBe("production")
      }
    })

    it("rejects production without a trusted proxy header but permits development", () => {
      expect(envSchema.safeParse({ ...validEnv, NODE_ENV: "production" }).success).toBe(false)
      expect(envSchema.safeParse({ ...validEnv, NODE_ENV: "development" }).success).toBe(true)
    })

    it("requires a LyraShield-owned immutable sandbox digest in production", () => {
      const production = {
        ...validEnv,
        NODE_ENV: "production",
        TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
      }
      expect(envSchema.safeParse(production).success).toBe(false)
      expect(
        envSchema.safeParse({
          ...production,
          LYRASHIELD_IMAGE:
            "ghcr.io/usestrix/strix-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }).success
      ).toBe(false)
      expect(
        envSchema.safeParse({
          ...production,
          LYRASHIELD_IMAGE:
            "ghcr.io/another-owner/another-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }).success
      ).toBe(false)
    })

    it("should accept NODE_ENV as test", () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: "test" })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.NODE_ENV).toBe("test")
      }
    })
  })

  describe("missing required fields", () => {
    it("should fail when DATABASE_URL is missing", () => {
      const { DATABASE_URL, ...rest } = validEnv
      void DATABASE_URL
      const result = envSchema.safeParse(rest)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("DATABASE_URL"))).toBe(true)
      }
    })

    it("should fail when BETTER_AUTH_SECRET is missing", () => {
      const { BETTER_AUTH_SECRET, ...rest } = validEnv
      void BETTER_AUTH_SECRET
      const result = envSchema.safeParse(rest)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("BETTER_AUTH_SECRET"))).toBe(true)
      }
    })

    it("should fail when BETTER_AUTH_URL is missing", () => {
      const { BETTER_AUTH_URL, ...rest } = validEnv
      void BETTER_AUTH_URL
      const result = envSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it("should fail when NEXT_PUBLIC_APP_URL is missing", () => {
      const { NEXT_PUBLIC_APP_URL, ...rest } = validEnv
      void NEXT_PUBLIC_APP_URL
      const result = envSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })
  })

  describe("invalid values", () => {
    it("should fail when DATABASE_URL is not a valid URL", () => {
      const result = envSchema.safeParse({ ...validEnv, DATABASE_URL: "not-a-url" })
      expect(result.success).toBe(false)
    })

    it("should fail when BETTER_AUTH_SECRET is less than 32 chars", () => {
      const result = envSchema.safeParse({ ...validEnv, BETTER_AUTH_SECRET: "short" })
      expect(result.success).toBe(false)
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes("BETTER_AUTH_SECRET"))
        expect(issue?.message).toContain("32")
      }
    })

    it("should fail when BETTER_AUTH_URL is not a valid URL", () => {
      const result = envSchema.safeParse({ ...validEnv, BETTER_AUTH_URL: "not-a-url" })
      expect(result.success).toBe(false)
    })

    it("should fail when NODE_ENV is not a valid enum value", () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: "staging" })
      expect(result.success).toBe(false)
    })
  })

  describe("optional fields", () => {
    it("defaults worker concurrency to one and rejects unsafe values", () => {
      expect(envSchema.parse(validEnv).LYRASHIELD_WORKER_CONCURRENCY).toBe(1)
      expect(envSchema.safeParse({ ...validEnv, LYRASHIELD_WORKER_CONCURRENCY: "0" }).success).toBe(
        false
      )
      expect(envSchema.safeParse({ ...validEnv, LYRASHIELD_WORKER_CONCURRENCY: "4" }).success).toBe(
        false
      )
    })

    it("should accept empty string for optional fields", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        GITHUB_CLIENT_ID: "",
        REDIS_URL: "",
        BREVO_API_KEY: "",
      })
      expect(result.success).toBe(true)
    })

    it("should accept valid URL for REDIS_URL", () => {
      const result = envSchema.safeParse({ ...validEnv, REDIS_URL: "redis://localhost:6379" })
      expect(result.success).toBe(true)
    })

    it("should accept valid URL for DATABASE_DIRECT_URL", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        DATABASE_DIRECT_URL: "postgresql://user:pass@localhost:5432/db",
      })
      expect(result.success).toBe(true)
    })

    it("defaults web search to disabled and validates mode/ranges", () => {
      const parsed = envSchema.parse(validEnv)
      expect(parsed.LYRASHIELD_WEB_SEARCH_ENABLED).toBe("0")
      expect(parsed.LYRASHIELD_WEB_SEARCH_MODE).toBeUndefined()
      expect(
        envSchema.safeParse({ ...validEnv, LYRASHIELD_WEB_SEARCH_MODE: "turbo" }).success
      ).toBe(true)
      expect(
        envSchema.safeParse({ ...validEnv, LYRASHIELD_WEB_SEARCH_MAX_RESULTS: "25" }).success
      ).toBe(false)
      expect(
        envSchema.safeParse({ ...validEnv, LYRASHIELD_WEB_SEARCH_BUDGET_USD: "-1" }).success
      ).toBe(false)
    })

    it("rejects web search enabled without an API key", () => {
      const enabledNoKey = envSchema.safeParse({
        ...validEnv,
        LYRASHIELD_WEB_SEARCH_ENABLED: "1",
        LYRASHIELD_WEB_SEARCH_API_KEY: "",
      })
      expect(enabledNoKey.success).toBe(false)
      if (!enabledNoKey.success) {
        expect(
          enabledNoKey.error.issues.some((i) => i.path.includes("LYRASHIELD_WEB_SEARCH_API_KEY"))
        ).toBe(true)
      }

      const enabledWithKey = envSchema.safeParse({
        ...validEnv,
        LYRASHIELD_WEB_SEARCH_ENABLED: "1",
        LYRASHIELD_WEB_SEARCH_API_KEY: "parallel-key",
      })
      expect(enabledWithKey.success).toBe(true)
    })

    it("should accept a privileged system URL when explicitly configured", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        DATABASE_SYSTEM_URL: "postgresql://system:pass@localhost:5432/db",
      })
      expect(result.success).toBe(true)
    })
  })

  it("enables GPT-5.6 prompt cache reads and writes by default", () => {
    const parsed = envSchema.parse(validEnv)
    expect(parsed.LYRASHIELD_PROMPT_CACHE_EXPLICIT).toBe("1")
    expect(parsed.LYRASHIELD_PROMPT_CACHE).toBe("1")
  })
})
