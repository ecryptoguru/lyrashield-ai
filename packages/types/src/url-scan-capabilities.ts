/**
 * Versioned URL and API scan capability registry.
 *
 * This is the single source of truth for the url-scan/2.0.0 contract:
 * profiles, limits, allowed methods, and release state. A change to any
 * numeric limit or allowed method is a contract change and must bump the
 * version and update fixtures.
 */

export const URL_SCAN_CONTRACT_VERSION = "url-scan/2.0.0" as const

export type UrlTargetType = "WEB_APP" | "API"

export type UrlScanMode = "SAFE" | "STANDARD" | "DEEP"

export type UrlRequestMethod = "GET" | "HEAD" | "OPTIONS"

export type UrlExecutionSummary = {
  contractVersion: string
  profile: string
  methods: UrlRequestMethod[]
  subjectCount: number
  documentCount: number
  assetCount: number
  operationCount: number
  methodProbeCount: number
  originProbeCount: number
  totalBytes: number
  truncated: boolean
  issueCodes: string[]
}

export type UrlScanProfileId =
  | "WEB_APP_SAFE"
  | "WEB_APP_STANDARD"
  | "WEB_APP_DEEP"
  | "API_SAFE"
  | "API_STANDARD"
  | "API_DEEP"

export type UrlScanProfile = {
  id: UrlScanProfileId
  targetType: UrlTargetType
  mode: UrlScanMode
  label: string
  description: string
  maxDocuments: number
  maxAssets: number
  maxDepth: number
  maxTotalBytes: number
  maxResponseBytes: number
  maxConcurrency: number
  maxWallTimeMs: number
  maxOperations: number
  maxMethodProbes: number
  maxOriginProbes: number
  allowedMethods: readonly UrlRequestMethod[]
  requiresApiSpec: boolean
}

const MiB = 1024 * 1024

const PROFILES = {
  WEB_APP_SAFE: {
    id: "WEB_APP_SAFE",
    targetType: "WEB_APP",
    mode: "SAFE",
    label: "Surface Review",
    description:
      "Fetch the exact submitted page and up to 6 same-origin JavaScript or CSS assets. Passive GET only.",
    maxDocuments: 1,
    maxAssets: 6,
    maxDepth: 0,
    maxTotalBytes: 8 * MiB,
    maxResponseBytes: 3 * MiB,
    maxConcurrency: 3,
    maxWallTimeMs: 60_000,
    maxOperations: 0,
    maxMethodProbes: 0,
    maxOriginProbes: 0,
    allowedMethods: ["GET"],
    requiresApiSpec: false,
  },
  WEB_APP_STANDARD: {
    id: "WEB_APP_STANDARD",
    targetType: "WEB_APP",
    mode: "STANDARD",
    label: "Expanded Surface Review",
    description:
      "Up to 20 same-origin pages and 30 client assets; passive GET requests only.",
    maxDocuments: 20,
    maxAssets: 30,
    maxDepth: 2,
    maxTotalBytes: 25 * MiB,
    maxResponseBytes: 3 * MiB,
    maxConcurrency: 4,
    maxWallTimeMs: 120_000,
    maxOperations: 0,
    maxMethodProbes: 0,
    maxOriginProbes: 0,
    allowedMethods: ["GET"],
    requiresApiSpec: false,
  },
  WEB_APP_DEEP: {
    id: "WEB_APP_DEEP",
    targetType: "WEB_APP",
    mode: "DEEP",
    label: "Behavioral Surface Review",
    description:
      "Expanded review plus bounded HEAD, OPTIONS, and CORS behavior checks; no state-changing requests.",
    maxDocuments: 40,
    maxAssets: 50,
    maxDepth: 3,
    maxTotalBytes: 50 * MiB,
    maxResponseBytes: 5 * MiB,
    maxConcurrency: 4,
    maxWallTimeMs: 180_000,
    maxOperations: 0,
    maxMethodProbes: 20,
    maxOriginProbes: 10,
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    requiresApiSpec: false,
  },
  API_SAFE: {
    id: "API_SAFE",
    targetType: "API",
    mode: "SAFE",
    label: "Endpoint Review",
    description:
      "Fetch one exact public endpoint and inspect transport, headers, exposed credentials, cookies, verbose errors, and response metadata.",
    maxDocuments: 1,
    maxAssets: 0,
    maxDepth: 0,
    maxTotalBytes: 5 * MiB,
    maxResponseBytes: 5 * MiB,
    maxConcurrency: 1,
    maxWallTimeMs: 30_000,
    maxOperations: 1,
    maxMethodProbes: 0,
    maxOriginProbes: 0,
    allowedMethods: ["GET"],
    requiresApiSpec: false,
  },
  API_STANDARD: {
    id: "API_STANDARD",
    targetType: "API",
    mode: "STANDARD",
    label: "Contract Review",
    description:
      "Static review plus at most 10 parameter-free unauthenticated GET/HEAD operations; requires an OpenAPI document.",
    maxDocuments: 0,
    maxAssets: 0,
    maxDepth: 0,
    maxTotalBytes: 20 * MiB,
    maxResponseBytes: 2 * MiB,
    maxConcurrency: 2,
    maxWallTimeMs: 90_000,
    maxOperations: 10,
    maxMethodProbes: 0,
    maxOriginProbes: 0,
    allowedMethods: ["GET", "HEAD"],
    requiresApiSpec: true,
  },
  API_DEEP: {
    id: "API_DEEP",
    targetType: "API",
    mode: "DEEP",
    label: "Contract Behavior Review",
    description:
      "At most 25 safe GET/HEAD/OPTIONS operations using documented parameter values; requires an OpenAPI document.",
    maxDocuments: 0,
    maxAssets: 0,
    maxDepth: 0,
    maxTotalBytes: 40 * MiB,
    maxResponseBytes: 2 * MiB,
    maxConcurrency: 2,
    maxWallTimeMs: 150_000,
    maxOperations: 25,
    maxMethodProbes: 0,
    maxOriginProbes: 10,
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    requiresApiSpec: true,
  },
} as const satisfies Record<UrlScanProfileId, UrlScanProfile>

export type UrlModeAvailability =
  | { available: true }
  | {
      available: false
      code: "URL_MODE_UNAVAILABLE" | "URL_MODE_UNSUPPORTED" | "API_SPEC_REQUIRED"
      reason: string
    }

export const RELEASED_URL_PROFILE_IDS = new Set<string>([
  "WEB_APP_SAFE",
  "WEB_APP_STANDARD",
  "WEB_APP_DEEP",
  "API_SAFE",
  "API_STANDARD",
  "API_DEEP",
])

const URL_SCAN_MODES: readonly UrlScanMode[] = ["SAFE", "STANDARD", "DEEP"]

function isUrlScanMode(value: string): value is UrlScanMode {
  return (URL_SCAN_MODES as readonly string[]).includes(value)
}

function normalizeMode(mode: string): string {
  return mode === "QUICK" ? "SAFE" : mode
}

export function getUrlScanProfile(targetType: UrlTargetType, mode: string): UrlScanProfile {
  const normalized = normalizeMode(mode)

  if (normalized === "CUSTOM") {
    throw new Error("URL_MODE_UNSUPPORTED")
  }

  if (!isUrlScanMode(normalized)) {
    throw new Error("URL_MODE_UNSUPPORTED")
  }

  const id = `${targetType}_${normalized}` as UrlScanProfileId
  const profile = PROFILES[id]

  if (!profile) {
    throw new Error("URL_MODE_UNSUPPORTED")
  }

  return profile
}

export function getUrlModeAvailability(
  targetType: UrlTargetType,
  mode: string,
  hasApiSpec: boolean,
  releasedIds: ReadonlySet<string> = RELEASED_URL_PROFILE_IDS
): UrlModeAvailability {
  const normalized = normalizeMode(mode)

  if (normalized === "CUSTOM") {
    return {
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: "This URL review depth is not available yet. Use Surface Review.",
    }
  }

  if (!isUrlScanMode(normalized)) {
    return {
      available: false,
      code: "URL_MODE_UNSUPPORTED",
      reason: `Mode '${mode}' is not supported for URL or API targets`,
    }
  }

  const id = `${targetType}_${normalized}` as UrlScanProfileId
  const profile = PROFILES[id]

  if (!profile) {
    return {
      available: false,
      code: "URL_MODE_UNSUPPORTED",
      reason: `Mode '${mode}' is not supported for ${targetType} targets`,
    }
  }

  if (!releasedIds.has(profile.id)) {
    return {
      available: false,
      code: "URL_MODE_UNAVAILABLE",
      reason: `${profile.label} is not available yet.`,
    }
  }

  if (profile.requiresApiSpec && !hasApiSpec) {
    return {
      available: false,
      code: "API_SPEC_REQUIRED",
      reason: `${profile.label} requires an OpenAPI document.`,
    }
  }

  return { available: true }
}

export type ResolveTargetScanModeInput = {
  targetType: string
  mode: string
  hasApiSpec: boolean
}

export type ResolveTargetScanModeResult =
  | { ok: true; profile: UrlScanProfile | null }
  | {
      ok: false
      code: Exclude<UrlModeAvailability, { available: true }>["code"]
      reason: string
    }

export function resolveTargetScanMode(
  input: ResolveTargetScanModeInput,
  releasedIds: ReadonlySet<string> = RELEASED_URL_PROFILE_IDS
): ResolveTargetScanModeResult {
  if (input.targetType !== "WEB_APP" && input.targetType !== "API") {
    return { ok: true, profile: null }
  }

  const availability = getUrlModeAvailability(
    input.targetType,
    input.mode,
    input.hasApiSpec,
    releasedIds
  )

  if (!availability.available) {
    return {
      ok: false,
      code: availability.code,
      reason: availability.reason,
    }
  }

  const profile = getUrlScanProfile(input.targetType, input.mode)
  return { ok: true, profile }
}
