import { URL_SCAN_CONTRACT_VERSION, type UrlScanProfile } from "@lyrashield/types"
import { analyzePublicSurface, type SurfaceSignal } from "./public-surface-analysis"
import type { SurfaceCollection } from "./public-surface"

export const LITE_CHECK_VERSION = "lite-2026-08-10.1" as const

export type LiteCheckSeverity = "needs_attention" | "worth_reviewing" | "ok"
export type LiteCheckCategory =
  | "exposed_secrets"
  | "security_headers"
  | "data_layer"
  | "transport"
  | "framework"

export type LiteCheck = {
  category: LiteCheckCategory
  severity: LiteCheckSeverity
  title: string
  whatItIs: string
  whyItMatters: string
  learnMoreUrl: string
}

export type LiteCheckResult = {
  target: string
  scannedAt: string
  version: typeof LITE_CHECK_VERSION
  checks: LiteCheck[]
  liteResultSummary: {
    needsAttention: number
    worthReviewing: number
    looksOk: number
    findingCount: number
  }
  disclaimers: string[]
}

type LiteSurface = {
  target: string
  html: string
  publicAssetText?: string
  headers: Record<string, string>
  status?: number
}

const LEARN_MORE_URL = "/methodology"

export const LITE_PUBLIC_VALUE_ALLOWLIST = [
  "Supabase anon and publishable JWTs",
  "Firebase web configuration",
  "Stripe publishable keys",
  "reCAPTCHA site keys",
] as const

const LITE_PROFILE: UrlScanProfile = {
  id: "WEB_APP_SAFE",
  targetType: "WEB_APP",
  mode: "SAFE",
  label: "Surface Review",
  description: "Public Lite Check surface review",
  maxDocuments: 1,
  maxAssets: 6,
  maxDepth: 0,
  maxTotalBytes: 8 * 1024 * 1024,
  maxResponseBytes: 3 * 1024 * 1024,
  maxConcurrency: 3,
  maxWallTimeMs: 60_000,
  maxOperations: 0,
  maxMethodProbes: 0,
  maxOriginProbes: 0,
  allowedMethods: ["GET"],
  requiresApiSpec: false,
} as const

function toLiteSeverity(signal: SurfaceSignal): LiteCheckSeverity {
  if (signal.state === "OBSERVED") return "worth_reviewing"
  if (signal.severity === "CRITICAL" || signal.severity === "HIGH") return "needs_attention"
  return "worth_reviewing"
}

function toLiteCategory(signal: SurfaceSignal): LiteCheckCategory {
  if (signal.id.includes("privileged-secret")) return "exposed_secrets"
  if (signal.id.includes("insecure-transport") || signal.id.includes("mixed-content")) return "transport"
  if (signal.id.includes("data-layer")) return "data_layer"
  if (signal.id.includes("source-map") || signal.id.includes("framework")) return "framework"
  if (signal.id.includes("verbose-error")) return "framework"
  return "security_headers"
}

function toLiteCheck(signal: SurfaceSignal): LiteCheck {
  const category = toLiteCategory(signal)
  let whyItMatters =
    signal.remediation ??
    "This is a surface-level signal. A clean or missing result here is not proof the system is secure."

  if (category === "data_layer") {
    whyItMatters =
      "Access safety depends on server-enforced row-level security or security rules. This passive check did not query any table, collection, or authenticated endpoint."
  }

  return {
    category,
    severity: toLiteSeverity(signal),
    title: signal.title,
    whatItIs: signal.description,
    whyItMatters,
    learnMoreUrl: LEARN_MORE_URL,
  }
}

function makeCollection(surface: LiteSurface): SurfaceCollection {
  const targetUrl = new URL(surface.target)
  const body = `${surface.html}\n${surface.publicAssetText ?? ""}`
  return {
    seedUrl: surface.target,
    finalOrigin: targetUrl.origin,
    contractVersion: URL_SCAN_CONTRACT_VERSION,
    profile: LITE_PROFILE,
    subjects: [
      {
        kind: "document" as const,
        requestedUrl: surface.target,
        finalUrl: surface.target,
        urlHistory: [surface.target],
        method: "GET" as const,
        status: surface.status ?? 200,
        headers: surface.headers,
        body,
        bodyBytes: Buffer.byteLength(body, "utf8"),
        bodyTruncated: false,
        depth: 0,
      },
    ],
    issues: [],
    totalBytes: Buffer.byteLength(body, "utf8"),
    truncated: false,
  }
}

function baselineChecks(): LiteCheck[] {
  return [
    {
      category: "framework",
      severity: "ok",
      title: "No supported framework marker found",
      whatItIs: "This version did not recognize a supported framework marker in the fetched assets.",
      whyItMatters:
        "Framework detection helps scope a deeper review; it does not determine whether the application is vulnerable.",
      learnMoreUrl: LEARN_MORE_URL,
    },
  ]
}

export function analyzeLiteSurface(surface: LiteSurface): LiteCheckResult {
  const collection = makeCollection(surface)
  const signals = analyzePublicSurface(collection)

  const checks: LiteCheck[] = signals.map(toLiteCheck)
  if (checks.length === 0) {
    checks.push(...baselineChecks())
  }

  const count = (severity: LiteCheckSeverity) =>
    checks.filter((check) => check.severity === severity).length
  const needsAttention = count("needs_attention")
  const worthReviewing = count("worth_reviewing")
  const looksOk = count("ok")

  return {
    target: new URL(surface.target).origin,
    scannedAt: new Date().toISOString(),
    version: LITE_CHECK_VERSION,
    checks,
    liteResultSummary: {
      needsAttention,
      worthReviewing,
      looksOk,
      findingCount: needsAttention + worthReviewing,
    },
    disclaimers: [
      "This is a surface-level, passive check — a preview of what LyraShield's full loop does. It can't see everything, and a clean result here isn't a guarantee.",
      "No authenticated access, exploit validation, table queries, or active RLS tests were performed.",
    ],
  }
}
