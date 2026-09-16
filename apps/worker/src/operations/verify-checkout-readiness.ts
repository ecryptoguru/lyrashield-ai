/**
 * verify:checkout-readiness — read-only preflight for billing launch.
 *
 * Validates that admission flags, provider credentials, and the product/plan
 * catalogs are coherent BEFORE a founder flips an admission or runs a live
 * purchase. It performs no network calls, creates no checkouts, and never
 * touches provider APIs — it reads process.env and prints a report.
 *
 * Usage: pnpm --filter @lyrashield/worker verify:checkout-readiness
 * Exit:  0 = all required checks pass, 1 = at least one gap.
 */

import { evaluateBillingAdmission, resolveProviderId } from "@lyrashield/billing"

type EnvLike = Record<string, string | undefined>

interface ReadinessCheck {
  name: string
  ok: boolean
  detail: string
  missing?: string[]
}

interface ReadinessReport {
  ok: boolean
  checks: ReadinessCheck[]
  /** Non-fatal observations the founder should still read. */
  notes: string[]
}

const SUBSCRIPTION_KEYS = [
  "starter_monthly",
  "starter_annual",
  "pro_monthly",
  "pro_annual",
  "launch_assurance_monthly",
  "launch_assurance_annual",
] as const
const PACK_KEYS = ["pack_100", "pack_250", "pack_500"] as const
const LOCAL_KEYS = ["individual_launch"] as const
const MODES = new Set(["off", "canary", "public"])

function catalogMissing(raw: string | undefined, keys: readonly string[]): string[] {
  return keys.filter((key) => !resolveProviderId(raw, key))
}

export function checkCheckoutReadiness(env: EnvLike): ReadinessReport {
  const checks: ReadinessCheck[] = []
  const notes: string[] = []

  const polarMode = env.POLAR_BILLING_ADMISSION ?? "off"
  const razorpayMode = env.RAZORPAY_BILLING_ADMISSION ?? "off"
  const polarLocal = env.POLAR_LOCAL_BILLING_ADMISSION ?? "off"
  const razorpayLocal = env.RAZORPAY_LOCAL_BILLING_ADMISSION ?? "off"
  const canaryIds = env.BILLING_CANARY_WORKSPACE_IDS ?? ""

  // ── Admission posture ────────────────────────────────────────────────────
  const modesValid =
    [polarMode, razorpayMode].every((m) => MODES.has(m)) &&
    [polarLocal, razorpayLocal].every((m) => m === "off" || m === "public")
  const canaryActive = polarMode === "canary" || razorpayMode === "canary"
  const canaryValid =
    !canaryActive ||
    (canaryIds.trim().length > 0 &&
      evaluateBillingAdmission({
        mode: "canary",
        workspaceId: "__preflight__",
        canaryWorkspaceIds: canaryIds,
      }).reason !== "invalid_allowlist")
  checks.push({
    name: "admission_posture",
    ok: modesValid && canaryValid,
    detail: `polar=${polarMode} razorpay=${razorpayMode} local_polar=${polarLocal} local_razorpay=${razorpayLocal}${
      canaryActive ? ` canary_ids=${canaryIds ? "set" : "MISSING"}` : ""
    }`,
  })
  if (!modesValid)
    notes.push("An admission env var holds an unrecognized value — treated as risky.")
  if (polarMode === "public" && razorpayMode === "off") {
    notes.push("Polar is public but Razorpay is off — INR-region buyers cannot self-serve.")
  }

  // ── Polar checks (required unless admission is off) ──────────────────────
  const polarOn = polarMode !== "off" || polarLocal === "public"
  const polarCredsMissing = [
    !env.POLAR_ACCESS_TOKEN ? "POLAR_ACCESS_TOKEN" : null,
    !env.POLAR_ENVIRONMENT ? "POLAR_ENVIRONMENT" : null,
    !env.POLAR_WEBHOOK_SECRET ? "POLAR_WEBHOOK_SECRET" : null,
  ].filter((v): v is string => Boolean(v))
  checks.push({
    name: "polar_credentials",
    ok: !polarOn || polarCredsMissing.length === 0,
    detail: polarOn
      ? polarCredsMissing.length === 0
        ? "token, environment and webhook secret present"
        : "missing credential fields"
      : "admission off — credentials not required",
    missing: polarOn ? polarCredsMissing : undefined,
  })
  checks.push({
    name: "polar_live_environment",
    ok: !polarOn || env.POLAR_ENVIRONMENT === "production",
    detail: polarOn ? `environment=${env.POLAR_ENVIRONMENT ?? "missing"}` : "admission off",
  })

  const polarMissing = catalogMissing(env.POLAR_PRODUCT_IDS, [...SUBSCRIPTION_KEYS, ...PACK_KEYS])
  checks.push({
    name: "polar_catalog",
    ok: polarMode === "off" || polarMissing.length === 0,
    detail:
      polarMode !== "off"
        ? polarMissing.length === 0
          ? "all plan×interval and pack keys resolve"
          : "catalog gaps"
        : "admission off — catalog not required",
    missing: polarMode !== "off" && polarMissing.length > 0 ? polarMissing : undefined,
  })

  const polarLocalMissing = catalogMissing(env.POLAR_LOCAL_PRODUCT_IDS, LOCAL_KEYS)
  checks.push({
    name: "polar_local_catalog",
    ok: polarLocal !== "public" || polarLocalMissing.length === 0,
    detail:
      polarLocal === "public"
        ? polarLocalMissing.length === 0
          ? "local SKU resolves"
          : "local catalog gaps"
        : "local admission off — catalog not required",
    missing:
      polarLocal === "public" && polarLocalMissing.length > 0 ? polarLocalMissing : undefined,
  })

  // ── Razorpay checks (required unless admission is off) ───────────────────
  const razorpayOn = razorpayMode !== "off" || razorpayLocal === "public"
  const razorpayCredsMissing = [
    !env.RAZORPAY_KEY_ID ? "RAZORPAY_KEY_ID" : null,
    !env.RAZORPAY_KEY_SECRET ? "RAZORPAY_KEY_SECRET" : null,
    !env.RAZORPAY_WEBHOOK_SECRET ? "RAZORPAY_WEBHOOK_SECRET" : null,
  ].filter((v): v is string => Boolean(v))
  checks.push({
    name: "razorpay_credentials",
    ok: !razorpayOn || razorpayCredsMissing.length === 0,
    detail: razorpayOn
      ? razorpayCredsMissing.length === 0
        ? "key id, secret and webhook secret present"
        : "missing credential fields"
      : "admission off — credentials not required",
    missing: razorpayOn ? razorpayCredsMissing : undefined,
  })

  // Razorpay packs are priced dynamically via payment links — only plan
  // subscriptions need catalog keys.
  const razorpayMissing = catalogMissing(env.RAZORPAY_PLAN_IDS, SUBSCRIPTION_KEYS)
  checks.push({
    name: "razorpay_catalog",
    ok: razorpayMode === "off" || razorpayMissing.length === 0,
    detail:
      razorpayMode !== "off"
        ? razorpayMissing.length === 0
          ? "all plan×interval keys resolve"
          : "catalog gaps"
        : "admission off — catalog not required",
    missing: razorpayMode !== "off" && razorpayMissing.length > 0 ? razorpayMissing : undefined,
  })

  // ── Surface checks ───────────────────────────────────────────────────────
  const appUrl = env.NEXT_PUBLIC_APP_URL ?? ""
  checks.push({
    name: "success_url_origin",
    ok: !polarOn && !razorpayOn ? appUrl.length > 0 : appUrl.startsWith("https://"),
    detail: appUrl ? `success URL origin ${appUrl}` : "NEXT_PUBLIC_APP_URL unset",
  })

  notes.push(
    "Preflight does NOT prove a live charge, settlement, payout, tax handling, or " +
      "payment-method coverage. Complete docs/checkout-verification.md for live evidence."
  )

  return { ok: checks.every((c) => c.ok), checks, notes }
}

function formatReadinessReport(report: ReadinessReport): string {
  const lines = ["Checkout readiness", "─".repeat(48)]
  for (const check of report.checks) {
    lines.push(`[${check.ok ? "OK" : "FAIL"}] ${check.name} — ${check.detail}`)
    for (const missing of check.missing ?? []) lines.push(`       missing: ${missing}`)
  }
  if (report.notes.length > 0) {
    lines.push("─".repeat(48))
    for (const note of report.notes) lines.push(`note: ${note}`)
  }
  lines.push("─".repeat(48), report.ok ? "READY (preflight only)" : "NOT READY")
  return lines.join("\n")
}

// CLI entry — only when executed directly, not on import.
if (process.argv[1]?.endsWith("verify-checkout-readiness.ts")) {
  const report = checkCheckoutReadiness(process.env)
  console.log(formatReadinessReport(report))
  process.exit(report.ok ? 0 : 1)
}
