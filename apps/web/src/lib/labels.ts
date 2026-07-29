export const GOAL_OPTIONS = [
  {
    value: "CHECK_PR",
    label: "Check a PR",
    description: "Review a pull request before merging.",
  },
  {
    value: "TEST_APP",
    label: "Code review",
    description: "Broader repository and dependency analysis.",
  },
  {
    value: "LAUNCH_REVIEW",
    label: "Release check",
    description: "Check what needs attention before release.",
  },
  {
    value: "WEEKLY_MONITOR",
    label: "Weekly monitor",
    description: "Set a recurring review goal.",
  },
  {
    value: "FULL_PENTEST",
    label: "Deep security review",
    description: "A thorough security review with evidence.",
  },
  {
    value: "COMPLIANCE_REVIEW",
    label: "Compliance review",
    description: "Map findings to compliance objectives.",
  },
] as const

export type GoalValue = (typeof GOAL_OPTIONS)[number]["value"]

export function getGoalLabel(value: string): string {
  return GOAL_OPTIONS.find((g) => g.value === value)?.label ?? value
}

export function getGoalDescription(value: string): string {
  return GOAL_OPTIONS.find((g) => g.value === value)?.description ?? ""
}
