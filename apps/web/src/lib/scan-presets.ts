export const SCAN_PRESETS = {
  RELEASE_CHECK: {
    label: "Release check",
    description: "Fast, bounded review before you ship.",
    goal: "LAUNCH_REVIEW",
    mode: "SAFE",
    maxCostUsd: 1.2,
  },
  CODE_REVIEW: {
    label: "Code review",
    description: "Broader repository and dependency analysis.",
    goal: "TEST_APP",
    mode: "STANDARD",
    maxCostUsd: 3.2,
  },
  DEEP_REVIEW: {
    label: "Deep security review",
    description: "High-reasoning review for complex or high-risk releases.",
    goal: "FULL_PENTEST",
    mode: "DEEP",
    maxCostUsd: 15,
  },
  WEEKLY_MONITOR: {
    label: "Weekly monitor",
    description: "A bounded recurring check for new risk.",
    goal: "WEEKLY_MONITOR",
    mode: "SAFE",
    maxCostUsd: 1.2,
  },
} as const

export type ScanPresetId = keyof typeof SCAN_PRESETS

export function getScanPreset(id: string) {
  return SCAN_PRESETS[id as ScanPresetId] ?? SCAN_PRESETS.RELEASE_CHECK
}
