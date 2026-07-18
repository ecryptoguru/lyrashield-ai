const DETERMINISTIC_SCANNERS = new Set(["sca", "secrets", "url", "agent_config"])

export function resolveRetestProfile(sourceMode: string, scannerSources: readonly string[]) {
  const deterministicSource = scannerSources.some((source) => DETERMINISTIC_SCANNERS.has(source))
  return deterministicSource
    ? {
        mode: "SAFE" as const,
        determinismMode: "targeted_scanner",
        reason:
          "Targeted retest queued with the bounded Safe review cap because the finding originated from a deterministic scanner.",
      }
    : {
        mode: sourceMode,
        determinismMode: "targeted_engine",
        reason:
          "Targeted retest queued with the source review depth because the finding requires engine analysis.",
      }
}
