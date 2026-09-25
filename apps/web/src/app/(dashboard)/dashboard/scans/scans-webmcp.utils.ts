/**
 * Shared resolution helpers for the scans-page WebMCP tools. The check,
 * prepare and request tools must resolve the same visible target by name and
 * the same available review option — one implementation keeps the three
 * adapters consistent.
 */
import { getManualScanOptions, type ManualScanOption } from "@/lib/scan-presets"
import type { TargetItem } from "./scan-types"

/** Case-insensitive exact visible-name match — identical semantics across
 * all three page tools. Throws when the name is absent or ambiguous. */
export function resolveVisibleTargetByName(targets: TargetItem[], targetName: string): TargetItem {
  const byName = targets.filter(
    (t) => t.name.localeCompare(targetName, undefined, { sensitivity: "base" }) === 0
  )
  if (byName.length === 0) {
    throw new Error(`No target named "${targetName}" is visible. Create or select a target first.`)
  }
  if (byName.length > 1) {
    throw new Error(
      `Multiple targets named "${targetName}" are visible. Select the target manually in the dashboard.`
    )
  }
  const [target] = byName
  if (!target) {
    throw new Error(`Target "${targetName}" was selected but is no longer visible.`)
  }
  return target
}

/**
 * The available review option a named reviewType selects — or the page's
 * current selection when it is still available, else the first available.
 * Throws for an unavailable requested type and when nothing is available.
 * Identical semantics across all three page tools.
 */
export function resolveReviewOption(
  target: TargetItem,
  reviewType: string | undefined,
  selectedPresetId: string
): ManualScanOption {
  const options = getManualScanOptions({
    type: target.type,
    hasApiSpec: Boolean(target.apiSpecUrl),
  }).filter((option) => option.available)
  const desired = reviewType?.trim()
  if (desired && !options.some((option) => option.id === desired)) {
    throw new Error(
      `Review type "${desired}" is not available for ${target.name}. Choose a different type or target.`
    )
  }
  const selectedOption = desired
    ? options.find((option) => option.id === desired)
    : (options.find((option) => option.id === selectedPresetId) ?? options[0])
  if (!selectedOption) {
    throw new Error(`No review option is available for ${target.name}. Add configuration first.`)
  }
  return selectedOption
}

export interface CheckSecurityScanResult {
  allowed: boolean
  code: string | null
  message: string | null
  plan: string | null
  isTrial: boolean | null
  remainingMinutes: number | null
  reviewType: { id: string; label: string; goal: string; mode: string }
  target: { name: string; type: string }
  note: string
}

/**
 * The `check_security_scan` handler: advisory read-only preflight against the
 * page's own session and workspace. The workspace id is bound at registration
 * (agent input can never supply it); the fetch goes to the same contract the
 * SDK/CLI/MCP adapters use. Only the returned verdict fields are surfaced —
 * no model names, costs or engine internals.
 */
export function createCheckSecurityScanHandler(deps: {
  workspaceId: string
  getTargets: () => TargetItem[]
  getSelectedPreset: () => string
  fetchFn?: typeof fetch
}) {
  const fetchImpl = deps.fetchFn ?? globalThis.fetch
  return async (
    input: { targetName: string; reviewType?: string },
    { signal }: { signal: AbortSignal }
  ): Promise<CheckSecurityScanResult> => {
    const target = resolveVisibleTargetByName(deps.getTargets(), input.targetName)
    const selectedOption = resolveReviewOption(target, input.reviewType, deps.getSelectedPreset())
    const params = new URLSearchParams({
      workspaceId: deps.workspaceId,
      targetId: target.id,
      goal: selectedOption.goal,
      mode: selectedOption.mode,
    })
    const response = await fetchImpl(`/api/scans/eligibility?${params.toString()}`, {
      method: "GET",
      signal,
    })
    const body = (await response.json().catch(() => null)) as {
      data?: {
        allowed?: boolean
        code?: string | null
        message?: string | null
        plan?: string | null
        isTrial?: boolean | null
        remainingMinutes?: number | null
      }
      error?: { code?: string; message?: string }
    } | null
    if (!response.ok) {
      throw new Error(body?.error?.message ?? "The eligibility check could not be completed.")
    }
    const data = body?.data ?? {}
    return {
      // allowed:false is a successful read carrying the denial code — the
      // agent sees exactly what the composer would show, nothing more.
      allowed: data.allowed === true,
      code: data.code ?? null,
      message: data.message ?? null,
      plan: data.plan ?? null,
      isTrial: data.isTrial ?? null,
      remainingMinutes: data.remainingMinutes ?? null,
      reviewType: {
        id: selectedOption.id,
        label: selectedOption.label,
        goal: selectedOption.goal,
        mode: selectedOption.mode,
      },
      target: { name: target.name, type: target.type },
      note: "Advisory check only — the scan is rechecked authoritatively when it is started.",
    }
  }
}
