const DETERMINISTIC_SCANNERS = new Set(["sca", "secrets", "url", "agent_config"])

export function resolveRetestProfile(sourceMode: string, scannerSources: readonly string[]) {
  const deterministicSource =
    scannerSources.length > 0 &&
    scannerSources.every((source) => DETERMINISTIC_SCANNERS.has(source))
  return deterministicSource
    ? {
        mode: "SAFE" as const,
        determinismMode: "targeted_scanner" as const,
        reason:
          "Targeted retest queued with the bounded Safe review cap because the finding originated from a deterministic scanner.",
      }
    : {
        mode: sourceMode,
        determinismMode: "targeted_engine" as const,
        reason:
          "Targeted retest queued with the source review depth because the finding requires engine analysis.",
      }
}
