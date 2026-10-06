import { getTargetTypeLabel } from "./enum-labels"

export function scheduleTargetOptionLabel(target: { name: string; type: string }): string {
  return `${target.name} (${getTargetTypeLabel(target.type)})`
}
