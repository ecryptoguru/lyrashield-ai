import { describe, it, expect } from "vitest"
import { z } from "zod"
import { billingStagingConfigError, resolveWorkerExecutionProvenanceFrom } from "./env"

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
    LYRASHIELD_EGRESS_PROXY_URL: z.string().url().optional().or(z.literal("")),
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
    POLAR_ENVIRONMENT: z.enum(["production", "sandbox"]).optional(),
    POLAR_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
    POLAR_BILLING_ADMISSION: z.enum(["off", "canary", "public"]).default("off"),
    POLAR_LOCAL_BILLING_ADMISSION: z.enum(["off", "public"]).default("off"),
    RAZORPAY_KEY_ID: z.string().optional().or(z.literal("")),
    RAZORPAY_KEY_SECRET: z.string().optional().or(z.literal("")),
    RAZORPAY_BILLING_ADMISSION: z.enum(["off", "canary", "public"]).default("off"),
    RAZORPAY_LOCAL_BILLING_ADMISSION: z.enum(["off", "public"]).default("off"),
    BILLING_CANARY_WORKSPACE_IDS: z.string().optional().default(""),
    RAZORPAYX_PAYOUT_ADMISSION: z.enum(["off", "public"]).default("off"),
    PAYONEER_PAYOUT_ADMISSION: z.literal("off").default("off"),
    SENTRY_DSN: z.string().optional().or(z.literal("")),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional().or(z.literal("")),
    AZURE_RESOURCE_GROUP: z.string().optional().or(z.literal("")),
    LYRASHIELD_PRODUCT_REVISION: z
      .string()
      .regex(/^[0-9a-fA-F]{40}$/, "LYRASHIELD_PRODUCT_REVISION must be a 40-character commit SHA")
      .optional()
      .or(z.literal("")),
    LYRASHIELD_WORKER_IMAGE_DIGEST: z
      .string()
      .regex(
        /^sha256:[0-9a-fA-F]{64}$/,
        "LYRASHIELD_WORKER_IMAGE_DIGEST must be a sha256:<64 hex> digest"
      )
      .optional()
      .or(z.literal("")),
    LYRASHIELD_ENGINE_REVISION: z
      .string()
      .regex(/^[0-9a-fA-F]{40}$/, "LYRASHIELD_ENGINE_REVISION must be a 40-character commit SHA")
      .optional()
      .or(z.literal("")),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .refine((val) => !val.POLAR_ACCESS_TOKEN || Boolean(val.POLAR_ENVIRONMENT), {
    path: ["POLAR_ENVIRONMENT"],
    message: "POLAR_ENVIRONMENT is required when POLAR_ACCESS_TOKEN is configured",
  })
  .refine((val) => val.NODE_ENV !== "production" || Boolean(val.TRUSTED_PROXY_IP_HEADER), {
    path: ["TRUSTED_PROXY_IP_HEADER"],
    message:
      "TRUSTED_PROXY_IP_HEADER is required in production or rate limiting degrades to a single global bucket",
  })
  .refine(
    (val) =>
      val.NODE_ENV !== "production" ||
      !val.LYRASHIELD_EGRESS_PROXY_URL ||
      val.LYRASHIELD_EGRESS_PROXY_URL.startsWith("https:"),
    {
      path: ["LYRASHIELD_EGRESS_PROXY_URL"],
      message:
        "LYRASHIELD_EGRESS_PROXY_URL must use https:// in production — the proxy is authenticated " +
        "with the LYRASHIELD_EGRESS_PROXY_SECRET bearer token, which an http:// URL would send in cleartext",
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

const validBillingStagingEnv = {
  NODE_ENV: "production",
  LYRASHIELD_DEPLOYMENT_ENVIRONMENT: "billing-staging",
  NEXT_PUBLIC_APP_URL:
    "https://lyrashield-billing-staging.examplehash.centralindia.azurecontainerapps.io",
  POLAR_ENVIRONMENT: "sandbox",
  RAZORPAY_KEY_ID: "rzp_test_example",
  POLAR_BILLING_ADMISSION: "off",
  POLAR_LOCAL_BILLING_ADMISSION: "off",
  RAZORPAY_BILLING_ADMISSION: "off",
  RAZORPAY_LOCAL_BILLING_ADMISSION: "off",
  BILLING_STAGING_ADMISSION: "restricted",
  BILLING_STAGING_ACCESS_TOKEN: "s".repeat(32),
  BILLING_STAGING_REGION: "usd",
}

describe("restricted billing staging configuration", () => {
  it("accepts only the isolated staging origin with sandbox/test providers", () => {
    expect(billingStagingConfigError(validBillingStagingEnv)).toBeNull()
  })

  it.each([
    ["production deployment", { LYRASHIELD_DEPLOYMENT_ENVIRONMENT: "production" }],
    ["production origin", { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com" }],
    ["Polar production", { POLAR_ENVIRONMENT: "production" }],
    ["Razorpay Live Mode", { RAZORPAY_KEY_ID: "rzp_live_example" }],
    ["public production rail", { POLAR_LOCAL_BILLING_ADMISSION: "public" }],
    ["missing access token", { BILLING_STAGING_ACCESS_TOKEN: "" }],
    ["missing server-side region", { BILLING_STAGING_REGION: "" }],
  ])("rejects %s", (_label, override) => {
    expect(billingStagingConfigError({ ...validBillingStagingEnv, ...override })).not.toBeNull()
  })
})

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

    it("defaults every purchase and payout rail to off", () => {
      const result = envSchema.safeParse(validEnv)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.POLAR_BILLING_ADMISSION).toBe("off")
        expect(result.data.RAZORPAY_BILLING_ADMISSION).toBe("off")
        expect(result.data.POLAR_LOCAL_BILLING_ADMISSION).toBe("off")
        expect(result.data.RAZORPAY_LOCAL_BILLING_ADMISSION).toBe("off")
        expect(result.data.RAZORPAYX_PAYOUT_ADMISSION).toBe("off")
        expect(result.data.PAYONEER_PAYOUT_ADMISSION).toBe("off")
      }
    })

    it("requires an explicit validated Polar environment with a configured token", () => {
      expect(
        envSchema.safeParse({
          ...validEnv,
          POLAR_ACCESS_TOKEN: "polar-token",
        }).success
      ).toBe(false)

      for (const POLAR_ENVIRONMENT of ["production", "sandbox"] as const) {
        expect(
          envSchema.safeParse({
            ...validEnv,
            POLAR_ACCESS_TOKEN: "polar-token",
            POLAR_ENVIRONMENT,
          }).success
        ).toBe(true)
      }

      expect(
        envSchema.safeParse({
          ...validEnv,
          POLAR_ACCESS_TOKEN: "polar-token",
          POLAR_ENVIRONMENT: "staging",
        }).success
      ).toBe(false)
    })

    it("should accept NODE_ENV as production with a trusted proxy header", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        NODE_ENV: "production",
        TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
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

    it("rejects an http egress proxy URL in production (bearer-token transport)", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        NODE_ENV: "production",
        TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
        LYRASHIELD_EGRESS_PROXY_URL: "http://proxy.internal:8080",
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.path.includes("LYRASHIELD_EGRESS_PROXY_URL")
        )
        expect(issue?.message).toContain("https://")
        expect(issue?.message).toContain("cleartext")
      }
    })

    it("accepts an https egress proxy URL in production", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        NODE_ENV: "production",
        TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
        LYRASHIELD_EGRESS_PROXY_URL: "https://proxy.internal:8443",
      })
      expect(result.success).toBe(true)
    })

    it("accepts an http egress proxy URL outside production (local proxies in dev/test)", () => {
      for (const nodeEnv of ["development", "test"] as const) {
        const result = envSchema.safeParse({
          ...validEnv,
          NODE_ENV: nodeEnv,
          LYRASHIELD_EGRESS_PROXY_URL: "http://localhost:8080",
        })
        expect(result.success).toBe(true)
      }
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

const PROD_WORKER_ENV = {
  NODE_ENV: "production",
  LYRASHIELD_PRODUCT_REVISION: "a".repeat(40),
  LYRASHIELD_WORKER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  LYRASHIELD_ENGINE_REVISION: "c".repeat(40),
}

describe("worker execution provenance", () => {
  it("accepts valid provenance values in the schema", () => {
    expect(
      envSchema.safeParse({
        ...validEnv,
        ...PROD_WORKER_ENV,
        TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
      }).success
    ).toBe(true)
  })

  it.each([
    ["short product revision", { LYRASHIELD_PRODUCT_REVISION: "abc" }],
    ["non-hex product revision", { LYRASHIELD_PRODUCT_REVISION: "z".repeat(40) }],
    ["missing sha256 prefix", { LYRASHIELD_WORKER_IMAGE_DIGEST: "b".repeat(64) }],
    ["short digest", { LYRASHIELD_WORKER_IMAGE_DIGEST: "sha256:abc" }],
    ["non-hex digest", { LYRASHIELD_WORKER_IMAGE_DIGEST: `sha256:${"z".repeat(64)}` }],
    ["short engine revision", { LYRASHIELD_ENGINE_REVISION: "def" }],
    ["non-hex engine revision", { LYRASHIELD_ENGINE_REVISION: "z".repeat(40) }],
  ])("rejects a malformed %s", (_label, override) => {
    expect(envSchema.safeParse({ ...validEnv, ...PROD_WORKER_ENV, ...override }).success).toBe(
      false
    )
  })

  it("returns null outside production so local scans do not invent provenance", () => {
    expect(
      resolveWorkerExecutionProvenanceFrom({ ...PROD_WORKER_ENV, NODE_ENV: "test" })
    ).toBeNull()
    expect(
      resolveWorkerExecutionProvenanceFrom({ ...PROD_WORKER_ENV, NODE_ENV: "development" })
    ).toBeNull()
  })

  it("returns the immutable provenance object when production values are complete", () => {
    expect(resolveWorkerExecutionProvenanceFrom(PROD_WORKER_ENV)).toEqual({
      productRevision: "a".repeat(40),
      workerImageDigest: `sha256:${"b".repeat(64)}`,
      engineRevision: "c".repeat(40),
    })
  })

  it.each([
    ["missing product revision", { LYRASHIELD_PRODUCT_REVISION: "" }],
    ["missing worker digest", { LYRASHIELD_WORKER_IMAGE_DIGEST: "" }],
    ["missing engine revision", { LYRASHIELD_ENGINE_REVISION: "" }],
    ["malformed product revision", { LYRASHIELD_PRODUCT_REVISION: "short" }],
    ["malformed worker digest", { LYRASHIELD_WORKER_IMAGE_DIGEST: "sha256:short" }],
    ["malformed engine revision", { LYRASHIELD_ENGINE_REVISION: "short" }],
  ])("fails closed in production with %s", (_label, override) => {
    expect(() => resolveWorkerExecutionProvenanceFrom({ ...PROD_WORKER_ENV, ...override })).toThrow(
      /Worker execution provenance is incomplete/
    )
  })
})
