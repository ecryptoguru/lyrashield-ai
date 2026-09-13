import { getUrlScanProfile, type UrlScanMode } from "./url-scan-capabilities"

export type RepositoryScanMode = "QUICK" | "STANDARD" | "DEEP"
export type ScanProfileModelClass = "LUNA" | "TERRA" | "NONE"

export type ScanProfile = {
  id: string
  targetType: "REPO" | "WEB_APP" | "API"
  canonicalMode: "SAFE" | RepositoryScanMode
  engineMode: "quick" | "standard" | "deep" | null
  maxBudgetUsd: number
  maxDurationMinutes: number
  scannerReserveMinutes: number
  maxEngineMinutes: number
  usesAi: boolean
  modelClass: ScanProfileModelClass
  label: string
  description: string
}

const REPOSITORY_MODE_ALIASES: Record<string, RepositoryScanMode> = {
  SAFE: "QUICK",
  QUICK: "QUICK",
  STANDARD: "STANDARD",
  DEEP: "DEEP",
  CUSTOM: "DEEP",
}

const REPOSITORY_PROFILES: Record<RepositoryScanMode, ScanProfile> = {
  QUICK: {
    id: "REPO_QUICK",
    targetType: "REPO",
    canonicalMode: "QUICK",
    engineMode: "quick",
    maxBudgetUsd: 1.2,
    maxDurationMinutes: 15,
    scannerReserveMinutes: 3,
    maxEngineMinutes: 12,
    usesAi: true,
    modelClass: "LUNA",
    label: "Release Check",
    description: "Fast, bounded repository review before you ship.",
  },
  STANDARD: {
    id: "REPO_STANDARD",
    targetType: "REPO",
    canonicalMode: "STANDARD",
    engineMode: "standard",
    maxBudgetUsd: 3.2,
    maxDurationMinutes: 15,
    scannerReserveMinutes: 3,
    maxEngineMinutes: 12,
    usesAi: true,
    modelClass: "LUNA",
    label: "Code Review",
    description: "Broader repository and dependency analysis.",
  },
  DEEP: {
    id: "REPO_DEEP",
    targetType: "REPO",
    canonicalMode: "DEEP",
    engineMode: "deep",
    maxBudgetUsd: 5,
    maxDurationMinutes: 45,
    scannerReserveMinutes: 5,
    maxEngineMinutes: 40,
    usesAi: true,
    modelClass: "TERRA",
    label: "Deep Security Review",
    description: "Deep cross-file review for complex or high-risk releases.",
  },
}

function normalizedMode(mode: string): string {
  return mode.trim().toUpperCase()
}

export function resolveScanProfile(input: { targetType: string; mode: string }): ScanProfile {
  const mode = normalizedMode(input.mode)
  if (input.targetType === "REPO") {
    const canonicalMode = REPOSITORY_MODE_ALIASES[mode]
    if (!canonicalMode) throw new Error("SCAN_MODE_UNSUPPORTED")
    return REPOSITORY_PROFILES[canonicalMode]
  }

  if (input.targetType === "WEB_APP" || input.targetType === "API") {
    const urlProfile = getUrlScanProfile(input.targetType, mode)
    // SAFE stays deterministic-only and unverified. STANDARD/DEEP are
    // engine-backed: the engine reaches the verified target through the
    // scan-scoped relay with repository-mode budgets and model classes.
    const engineBacked = urlProfile.mode !== "SAFE"
    const deep = urlProfile.mode === "DEEP"
    return {
      id: urlProfile.id,
      targetType: input.targetType,
      canonicalMode: urlProfile.mode as UrlScanMode,
      engineMode: engineBacked ? (deep ? "deep" : "standard") : null,
      maxBudgetUsd: engineBacked ? (deep ? 5 : 3.2) : 0,
      maxDurationMinutes: engineBacked
        ? deep
          ? 45
          : 15
        : Math.ceil(urlProfile.maxWallTimeMs / 60_000),
      scannerReserveMinutes: engineBacked ? (deep ? 5 : 3) : 0,
      maxEngineMinutes: engineBacked ? (deep ? 40 : 12) : 0,
      usesAi: engineBacked,
      modelClass: engineBacked ? (deep ? "TERRA" : "LUNA") : "NONE",
      label: engineBacked ? (deep ? "Deep Live Review" : "Engine Review") : urlProfile.label,
      description: engineBacked
        ? `${urlProfile.description} Engine-driven review of the verified target; deterministic surface checks run alongside.`
        : urlProfile.description,
    }
  }

  throw new Error("TARGET_TYPE_UNSUPPORTED")
}
