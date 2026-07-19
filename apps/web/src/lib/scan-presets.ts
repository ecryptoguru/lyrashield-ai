export const SCAN_PRESETS = {
  RELEASE_CHECK: {
    label: "Release check",
    description: "Fast, bounded review before you ship.",
    goal: "LAUNCH_REVIEW",
    mode: "SAFE",
  },
  CODE_REVIEW: {
    label: "Code review",
    description: "Broader repository and dependency analysis.",
    goal: "TEST_APP",
    mode: "STANDARD",
  },
  DEEP_REVIEW: {
    label: "Deep security review",
    description: "Deep cross-file review for complex or high-risk releases.",
    goal: "FULL_PENTEST",
    mode: "DEEP",
  },
  WEEKLY_MONITOR: {
    label: "Weekly monitor",
    description: "A bounded recurring check for new risk.",
    goal: "WEEKLY_MONITOR",
    mode: "SAFE",
  },
} as const

export type ScanPresetId = keyof typeof SCAN_PRESETS

export function getScanPreset(id: string) {
  return SCAN_PRESETS[id as ScanPresetId] ?? SCAN_PRESETS.RELEASE_CHECK
}
