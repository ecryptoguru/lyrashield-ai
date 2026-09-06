const DETERMINISTIC_SCANNERS = new Set([
  "sca",
  "secrets",
  "url",
  "agent_config",
  "ai_app_security",
  "ml_supply_chain",
])

export function resolveRetestProfile(sourceMode: string, scannerSources: readonly string[]) {
  const deterministicSource =
    scannerSources.length > 0 &&
    scannerSources.every((source) => DETERMINISTIC_SCANNERS.has(source))
  return deterministicSource
    ? {
        mode: "SAFE" as const,
        determinismMode: "targeted_scanner" as const,
        reason:
          "Targeted deterministic retest queued. Repository retests use an independently checked out source revision without model analysis; other review coverage is outside this retest scope.",
      }
    : {
        mode: sourceMode,
        determinismMode: "targeted_engine" as const,
        reason:
          "Targeted retest queued with the source review depth because the finding requires engine analysis.",
      }
}
