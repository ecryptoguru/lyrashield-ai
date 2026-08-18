import { z } from "zod"

const envSchema = z
  .object({
    // Database
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL connection URL"),
    DATABASE_DIRECT_URL: z.string().url().optional().or(z.literal("")),
    // Privileged cross-workspace/system operations only (public share-token
    // resolution and verified provider webhooks). Ordinary app queries must
    // use the NOBYPASSRLS DATABASE_URL role.
    DATABASE_SYSTEM_URL: z.string().url().optional().or(z.literal("")),
    // Prisma shadow DB for migration development; unused in production deployments.
    SHADOW_DATABASE_URL: z.string().url().optional().or(z.literal("")),

    // Redis (redis:// URL — reserved for the BullMQ job queue, Sprint 4+)
    REDIS_URL: z.string().url().optional().or(z.literal("")),

    // Upstash Redis REST (HTTP) — distributed rate limiting in production.
    // These are the HTTPS REST endpoint + token, NOT the redis:// REDIS_URL above.
    UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal("")),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional().or(z.literal("")),

    // Better Auth
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
    // Comma-separated extra origins trusted for auth/CSRF (staging, apex+www,
    // preview deploys). BETTER_AUTH_URL is always trusted; these are appended.
    ADDITIONAL_TRUSTED_ORIGINS: z.string().optional().or(z.literal("")),
    // Domain shared by app and marketing subdomains when enabling cross-subdomain cookies.
    BETTER_AUTH_COOKIE_DOMAIN: z.string().optional().or(z.literal("")),

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
    // The GitHub App's OWN OAuth credentials (App settings → General → Client
    // ID / Client secret). Distinct from GITHUB_CLIENT_ID/SECRET above, which
    // belong to the social-login OAuth app. Required by the install callback's
    // ownership check: without them a first-time install cannot be verified and
    // the flow fails closed.
    GITHUB_APP_CLIENT_ID: z.string().optional().or(z.literal("")),
    GITHUB_APP_CLIENT_SECRET: z.string().optional().or(z.literal("")),

    // MCP / Agent Action Layer
    LYRASHIELD_API_URL: z.string().url().optional().or(z.literal("")),
    LYRASHIELD_API_KEY: z.string().optional().or(z.literal("")),
    // Fail-closed opt-outs for the MCP human-approval gate. Only enable in trusted CI contexts.
    LYRASHIELD_MCP_ALLOW_MUTATIONS: z.enum(["true", "false"]).optional().or(z.literal("")),
    LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS: z.enum(["true", "false"]).optional().or(z.literal("")),

    // App
    NEXT_PUBLIC_APP_URL: z.string().url("NEXT_PUBLIC_APP_URL must be a valid URL"),
    NEXT_PUBLIC_MARKETING_URL: z.string().url().optional().or(z.literal("")),
    // Product analytics (PostHog) — mirrors marketing privacy config
    NEXT_PUBLIC_POSTHOG_KEY: z.string().optional().or(z.literal("")),
    NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional().or(z.literal("")),
    // Cloudflare Turnstile secret (server-side). Public site key lives in apps/marketing/.env.example.
    TURNSTILE_SECRET_KEY: z.string().optional().or(z.literal("")),
    TRUSTED_PROXY_IP_HEADER: z
      .enum(["cf-connecting-ip", "true-client-ip", "x-real-ip", "x-forwarded-for"])
      .optional()
      .or(z.literal("")),

    // Scan Engine (Sprint 5+)
    LYRASHIELD_LLM: z.string().optional().or(z.literal("")),
    LYRASHIELD_LUNA_LLM: z.string().optional().or(z.literal("")),
    LYRASHIELD_TERRA_LLM: z.string().optional().or(z.literal("")),
    LLM_API_KEY: z.string().optional().or(z.literal("")),
    LLM_API_BASE: z.string().optional().or(z.literal("")),
    LLM_API_VERSION: z.string().optional().or(z.literal("")),
    LYRASHIELD_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
    LYRASHIELD_MAX_INPUT_TOKENS: z.coerce.number().int().positive().optional(),
    // GPT-5.6 explicit cache breakpoints. The engine ignores this for unsupported models.
    LYRASHIELD_PROMPT_CACHE_EXPLICIT: z.enum(["0", "1"]).optional().default("1"),
    LYRASHIELD_PROMPT_CACHE: z.enum(["0", "1"]).optional().default("1"),
    LYRASHIELD_IMAGE: z.string().optional().or(z.literal("")),
    LYRASHIELD_ENGINE_PATH: z.string().optional().or(z.literal("")),
    LYRASHIELD_RUNTIME_BACKEND: z.enum(["docker"]).optional().or(z.literal("")),
    LYRASHIELD_ENGINE_SANDBOX_NETWORK: z.string().optional().or(z.literal("")),
    // Explicit opt-in to run scan sandboxes on the worker's LOCAL Docker daemon
    // (single-VM topology with a dedicated egress-restricted network + firewall).
    // Without it, production requires an isolated ssh:// or tcp:// DOCKER_HOST.
    // Honored only when LYRASHIELD_ENGINE_SANDBOX_NETWORK is also set.
    LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST: z
      .enum(["0", "1", "true", "false"])
      .optional()
      .or(z.literal("")),
    // Worker-local directory where the engine writes run artifacts. Defaults to cwd/lyrashield_runs.
    LYRASHIELD_ENGINE_WORK_ROOT: z.string().optional().or(z.literal("")),
    // Conservative crash recovery: only resources older than this threshold
    // and not associated with an active database scan can be removed.
    LYRASHIELD_STALE_RESOURCE_REAPER_ENABLED: z.enum(["0", "1"]).optional().default("1"),
    LYRASHIELD_STALE_RESOURCE_MIN_AGE_MINUTES: z.coerce
      .number()
      .int()
      .min(60)
      .max(10_080)
      .default(1_440),
    LYRASHIELD_STALE_RESOURCE_REAPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(900_000),
    LYRASHIELD_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(3).default(1),
    SCANNER_PHASE_TIMEOUT_MS: z.coerce.number().int().positive().max(3_600_000).default(600_000),
    // Optional authenticated egress proxy for URL scanning. When both URL and secret are
    // set, the worker routes safeFetchDetailed through this proxy instead of direct egress.
    LYRASHIELD_EGRESS_PROXY_URL: z.string().url().optional().or(z.literal("")),
    LYRASHIELD_EGRESS_PROXY_SECRET: z.string().optional().or(z.literal("")),
    // Egress proxy connect/read timeouts in milliseconds. If the proxy itself hangs
    // (hung upstream, network partition), the worker-side fetch to the proxy must not
    // stall the scan indefinitely. Defaults: connect 10s, read 30s.
    LYRASHIELD_EGRESS_PROXY_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(120_000)
      .default(10_000),
    LYRASHIELD_EGRESS_PROXY_READ_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(30_000),
    PLATFORM_MAX_SCAN_BUDGET_USD: z.coerce.number().positive().max(1000).default(50),
    // Disabled by default. When enabled, eligible paid repository scans may
    // request an additive, redacted engine triage overlay within this cap.
    LYRASHIELD_AI_TRIAGE_ENABLED: z.enum(["0", "1"]).optional().default("0"),
    LYRASHIELD_AI_TRIAGE_MAX_BUDGET_USD: z.coerce.number().positive().max(5).default(0.2),
    // Docker sandbox resource limits passed to the Strix engine (e.g. "4g", "2", "512").
    STRIX_SANDBOX_MEM_LIMIT: z.string().optional().default("4g"),
    STRIX_SANDBOX_CPUS: z.string().optional().default("2"),
    STRIX_SANDBOX_PIDS_LIMIT: z.string().optional().default("512"),

    // Web Search (Parallel Search). Disabled by default; enable only when an API key is configured.
    LYRASHIELD_WEB_SEARCH_ENABLED: z.enum(["0", "1"]).optional().default("0"),
    LYRASHIELD_WEB_SEARCH_API_KEY: z.string().optional().or(z.literal("")),
    LYRASHIELD_WEB_SEARCH_PROVIDER: z.string().optional().or(z.literal("")),
    LYRASHIELD_WEB_SEARCH_MODE: z.enum(["turbo", "basic", "advanced"]).optional().or(z.literal("")),
    LYRASHIELD_WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(20).optional(),
    LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL: z.coerce.number().int().min(1000).max(20000).optional(),
    LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN: z.coerce.number().int().min(0).optional(),
    LYRASHIELD_WEB_SEARCH_BUDGET_USD: z.coerce.number().min(0).optional(),

    // Azure OpenAI (optional — use these OR the generic LLM_API_KEY/LLM_API_BASE)
    AZURE_OPENAI_API_KEY: z.string().optional().or(z.literal("")),
    AZURE_OPENAI_ENDPOINT: z.string().optional().or(z.literal("")),
    AZURE_OPENAI_API_BASE: z.string().optional().or(z.literal("")),
    // Azure AI project / serverless (e.g. azure_ai/gpt-5.6-terra)
    AZURE_AI_API_KEY: z.string().optional().or(z.literal("")),
    AZURE_AI_API_BASE: z.string().optional().or(z.literal("")),
    AZURE_API_VERSION: z.string().optional().or(z.literal("")),
    AZURE_OPENAI_API_VERSION: z.string().optional().or(z.literal("")),

    // Evidence Storage
    S3_ENDPOINT: z.string().optional().or(z.literal("")),
    S3_ACCESS_KEY: z.string().optional().or(z.literal("")),
    S3_SECRET_KEY: z.string().optional().or(z.literal("")),
    S3_BUCKET: z.string().optional().or(z.literal("")),
    S3_REGION: z.string().optional().or(z.literal("")),
    // Base64-encoded 32-byte key-encryption key for evidence envelope encryption.
    // Required (fail-closed) when S3 evidence storage is configured: each artifact
    // is sealed with a per-object data key that is itself encrypted under this KEK.
    LYRASHIELD_EVIDENCE_KEK: z.string().optional().or(z.literal("")),
    // Local Compose-only encrypted evidence store. Production must use S3-compatible storage.
    LYRASHIELD_LOCAL_EVIDENCE_STORAGE: z.enum(["0", "1"]).optional().default("0"),
    LYRASHIELD_LOCAL_EVIDENCE_DIR: z.string().optional().or(z.literal("")),

    // Email (Brevo)
    // Defaults ON. Open registration without verification lets anyone register as any
    // address, so the insecure state must now be chosen deliberately rather than inherited
    // from a default. Until 2026-07-30 this flag was declared but never read by any code.
    LYRASHIELD_REQUIRE_EMAIL_VERIFICATION: z.enum(["0", "1"]).optional().default("1"),
    BREVO_API_KEY: z.string().optional().or(z.literal("")),
    EMAIL_FROM: z.string().optional().or(z.literal("")),

    // Notifications — Slack & Discord webhooks
    SLACK_WEBHOOK_URL: z.string().optional().or(z.literal("")),
    DISCORD_WEBHOOK_URL: z.string().optional().or(z.literal("")),
    NOTIFICATION_FROM_EMAIL: z.string().optional().or(z.literal("")),

    // Billing (Sprint 10)
    POLAR_ACCESS_TOKEN: z.string().optional().or(z.literal("")),
    POLAR_ORG_ID: z.string().optional().or(z.literal("")),
    POLAR_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
    POLAR_WEBHOOK_TOLERANCE_MS: z.coerce.number().int().positive().max(3_600_000).default(300_000),
    RAZORPAY_KEY_ID: z.string().optional().or(z.literal("")),
    RAZORPAY_KEY_SECRET: z.string().optional().or(z.literal("")),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
    BILLING_GEO_IP_HEADER: z.string().optional().or(z.literal("").or(z.literal("cf-connecting-ip"))),

    // Monitoring
    SENTRY_DSN: z.string().optional().or(z.literal("")),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional().or(z.literal("")),

    // Runtime
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  })
  .refine(
    // If an Upstash REST URL is configured, a token must accompany it — a URL
    // without a token silently falls back to per-instance in-memory limiting.
    (val) => !(val.UPSTASH_REDIS_REST_URL && !val.UPSTASH_REDIS_REST_TOKEN),
    {
      path: ["UPSTASH_REDIS_REST_TOKEN"],
      message: "UPSTASH_REDIS_REST_TOKEN is required when UPSTASH_REDIS_REST_URL is set",
    }
  )
  .refine(
    // Web search is fail-closed: enabling it without an API key would fail at
    // engine runtime and produce a confusing scan error. Build-time builds may
    // not have the key, so the check is skipped during the Next.js build phase.
    (val) =>
      process.env.NEXT_PHASE === "phase-production-build" ||
      val.LYRASHIELD_WEB_SEARCH_ENABLED !== "1" ||
      Boolean(val.LYRASHIELD_WEB_SEARCH_API_KEY),
    {
      path: ["LYRASHIELD_WEB_SEARCH_API_KEY"],
      message: "LYRASHIELD_WEB_SEARCH_API_KEY is required when LYRASHIELD_WEB_SEARCH_ENABLED=1",
    }
  )
  .refine((val) => val.NODE_ENV !== "production" || Boolean(val.TRUSTED_PROXY_IP_HEADER), {
    path: ["TRUSTED_PROXY_IP_HEADER"],
    message:
      "TRUSTED_PROXY_IP_HEADER is required in production or rate limiting degrades to a single global bucket",
  })
  // The egress proxy authenticates the worker with the bearer token in
  // LYRASHIELD_EGRESS_PROXY_SECRET; an http:// proxy URL would transmit that
  // secret in cleartext. Dev/test keep http:// for local proxies. Unlike the
  // BREVO rule below this needs no NEXT_PHASE build carve-out: the variable is
  // runtime-only, so a production build that sets it to an http:// URL is a
  // genuine misconfiguration and should fail rather than ship.
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
  // Claiming to verify email addresses without a way to send the mail is worse than not
  // claiming it: sign-up would either break or silently fall through unverified.
  //
  // Enforced at runtime only. `next build` evaluates this module with NODE_ENV=production,
  // and compiling an image must not require runtime secrets — otherwise CI and the Docker
  // build would need a live mail key to produce an artifact. The check still fires when the
  // server actually boots, which is where it matters.
  .refine(
    (val) =>
      val.NODE_ENV !== "production" ||
      process.env.NEXT_PHASE === "phase-production-build" ||
      val.LYRASHIELD_REQUIRE_EMAIL_VERIFICATION !== "1" ||
      Boolean(val.BREVO_API_KEY),
    {
      path: ["BREVO_API_KEY"],
      message:
        "BREVO_API_KEY is required in production while LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=1. " +
        "Set the key to enforce verification, or set LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 to " +
        "accept unverified open registration as a deliberate choice.",
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
