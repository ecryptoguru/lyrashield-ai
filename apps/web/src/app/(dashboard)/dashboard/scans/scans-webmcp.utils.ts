/**
 * Shared resolution helpers and page-tool definitions for the scans-page
 * WebMCP tools. The check, prepare and request tools must resolve the same
 * visible target by name and the same available review option — one
 * implementation keeps the three adapters consistent.
 *
 * Each `create*Tool` factory returns the complete registration options the
 * hook feeds to `registerWebMcpTool` (plus the session receipt store), so the
 * tool surface is testable without a browser: the same definitions run the
 * real registration path in unit tests.
 */
import { getManualScanOptions, type ManualScanOption } from "@/lib/scan-presets"
import type { WebMcpInputSchema, WebMcpPageTool } from "@/lib/webmcp/register"
import type { TargetItem } from "./scan-types"

/**
 * Inputs the page tools must never accept from an agent: tenancy, principals,
 * foreign resource ids and secret-shaped keys are bound to the page's own
 * session and workspace, never to tool input.
 */
export const SCANS_WEBMCP_FORBIDDEN_INPUT_KEYS = [
  "workspaceId",
  "workspace",
  "userId",
  "user",
  "targetId",
  "evidence",
  "secret",
] as const

const prepareScanInputSchema: WebMcpInputSchema = {
  required: ["targetName"],
  properties: {
    targetName: {
      type: "string",
      description: "The unique visible target name.",
    },
    reviewType: {
      type: "string",
      description: "Optional review type id. Defaults to the first available option.",
    },
  },
}

const checkScanInputSchema: WebMcpInputSchema = {
  required: ["targetName"],
  properties: {
    targetName: {
      type: "string",
      description: "The unique visible target name.",
    },
    reviewType: {
      type: "string",
      description: "Optional review type id. Defaults to the first available option.",
    },
  },
}

const requestScanInputSchema: WebMcpInputSchema = {
  required: ["targetName", "requestId"],
  properties: {
    requestId: {
      type: "string",
      description:
        "Unique ID for this requested scan. Reuse only for an identical retry; use a new ID for a new scan.",
    },
    targetName: {
      type: "string",
      description: "The unique visible target name.",
    },
    reviewType: {
      type: "string",
      description: "Optional review type id. Defaults to the first available option.",
    },
  },
}

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
  /** Advisory blockers the server reported — bounded, verbatim {code,message}. */
  blockers: { code: string; message: string }[]
  /** Advisory limitations — evidence the preflight cannot establish yet. */
  limitations: string[]
  reviewType: { id: string; label: string; goal: string; mode: string }
  target: { name: string; type: string }
  note: string
}

const MAX_ADVISORY_BLOCKERS = 4
const MAX_ADVISORY_LIMITATIONS = 3
const MAX_ADVISORY_TEXT = 200

function parseAdvisoryBlockers(value: unknown): { code: string; message: string }[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []
      const blocker = item as Record<string, unknown>
      if (typeof blocker.code !== "string" || typeof blocker.message !== "string") return []
      return [
        {
          code: blocker.code.slice(0, MAX_ADVISORY_TEXT),
          message: blocker.message.slice(0, MAX_ADVISORY_TEXT),
        },
      ]
    })
    .slice(0, MAX_ADVISORY_BLOCKERS)
}

function parseAdvisoryLimitations(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, MAX_ADVISORY_LIMITATIONS)
    .map((item) => item.slice(0, MAX_ADVISORY_TEXT))
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
        blockers?: unknown
        limitations?: unknown
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
      blockers: parseAdvisoryBlockers(data.blockers),
      limitations: parseAdvisoryLimitations(data.limitations),
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

// ── Page tool definitions ───────────────────────────────────────────────────
// The hook registers these verbatim (adding only the session receipt store).
// They are factories so the *actual* registered surface — name, budget-safe
// description, forbidden keys, handler — is exercised directly in tests.

export interface ScansPageToolDeps {
  workspaceId: string
  getTargets: () => TargetItem[]
  getSelectedPreset: () => string
  fetchFn?: typeof fetch
}

type CheckScanInput = { targetName: string; reviewType?: string }
type PrepareScanInput = { targetName: string; reviewType?: string }
type RequestScanInput = { requestId: string; targetName: string; reviewType?: string }

/** `check_security_scan` — advisory read-only preflight on the page's own
 * workspace/session. Same verdict semantics the SDK/CLI/MCP adapters expose. */
export function createCheckSecurityScanTool(
  deps: ScansPageToolDeps
): WebMcpPageTool<CheckScanInput> {
  const handler = createCheckSecurityScanHandler(deps)
  return {
    name: "check_security_scan",
    title: "Check security scan",
    description:
      "Advisory read-only check whether starting a scan for a target and review type would currently be admitted. Returns the server's verdict; does not start the scan.",
    inputSchema: checkScanInputSchema,
    classification: "read",
    dataClass: "workspace-summary",
    untrustedContent: false,
    uiChanged: false,
    durableMutation: false,
    humanConfirmationRequired: false,
    forbiddenInputKeys: SCANS_WEBMCP_FORBIDDEN_INPUT_KEYS,
    receiptProjection: (result) => {
      const resolved = result as CheckSecurityScanResult
      return {
        references: {
          target: resolved.target.name,
          reviewType: resolved.reviewType.id,
        },
        href: "/dashboard/scans",
      }
    },
    handler,
  }
}

/** `prepare_security_scan` — prepares the visible composer for human
 * confirmation. Prepares UI only; never posts. */
export function createPrepareSecurityScanTool(
  deps: Pick<ScansPageToolDeps, "getTargets" | "getSelectedPreset"> & {
    setSelectedTarget: (targetId: string) => void
    setSelectedPreset: (presetId: string) => void
    setShowCreate: (show: boolean) => void
    setModeResetNotice: (notice: string | null) => void
  }
): WebMcpPageTool<PrepareScanInput> {
  return {
    name: "prepare_security_scan",
    title: "Prepare security scan",
    description:
      "Prepare the scan creation form for a target and review type. Does not start the scan.",
    inputSchema: prepareScanInputSchema,
    classification: "mutation-prepared",
    dataClass: "workspace-summary",
    untrustedContent: false,
    uiChanged: true,
    durableMutation: false,
    humanConfirmationRequired: true,
    forbiddenInputKeys: SCANS_WEBMCP_FORBIDDEN_INPUT_KEYS,
    handler: async (input) => {
      const target = resolveVisibleTargetByName(deps.getTargets(), input.targetName)
      const selectedOption = resolveReviewOption(target, input.reviewType, deps.getSelectedPreset())

      // Prepare the existing form for human confirmation. No apiPost.
      deps.setSelectedTarget(target.id)
      deps.setSelectedPreset(selectedOption.id)
      deps.setShowCreate(true)
      deps.setModeResetNotice(null)

      return {
        prepared: true,
        target: { name: target.name, type: target.type },
        reviewType: {
          id: selectedOption.id,
          label: selectedOption.label,
          goal: selectedOption.goal,
          mode: selectedOption.mode,
        },
        nextStep: "Click the Start button to create the scan.",
        note: "This tool only prepared the form. A durable scan requires your confirmation.",
      }
    },
  }
}

/** `request_security_scan` — the durable execution tool (W3-07). Server-bound
 * workspace/principal identity, W3-01 idempotency semantics, and the
 * authoritative admission checks live on the server; agent input can never
 * supply another workspace or principal. */
export function createRequestSecurityScanTool(
  deps: ScansPageToolDeps
): WebMcpPageTool<RequestScanInput> {
  return {
    name: "request_security_scan",
    title: "Request security scan",
    // Disclose durability and cost *inside* the 150-char budget — the
    // composer's sheet description carries the same disclosure for humans.
    description:
      "Start a durable scan for a target and review type. Persisted work that may consume sponsoring-account allowance; eligibility is rechecked at start.",
    inputSchema: requestScanInputSchema,
    classification: "mutation-durable",
    dataClass: "workspace-summary",
    untrustedContent: false,
    uiChanged: false,
    durableMutation: true,
    humanConfirmationRequired: false,
    forbiddenInputKeys: SCANS_WEBMCP_FORBIDDEN_INPUT_KEYS,
    receiptProjection: (result, input) => {
      const accepted = result as { scanId?: string; operationId?: string }
      return {
        references: {
          requestId: input.requestId,
          ...(accepted.scanId ? { scanId: accepted.scanId } : {}),
          ...(accepted.operationId ? { operationId: accepted.operationId } : {}),
        },
        href: accepted.scanId ? `/dashboard/scans/${accepted.scanId}` : "/dashboard/scans",
      }
    },
    handler: async (input, { signal }) => {
      const target = resolveVisibleTargetByName(deps.getTargets(), input.targetName)
      const selectedOption = resolveReviewOption(target, input.reviewType, deps.getSelectedPreset())

      // Cancellation after server acceptance reports the existing or
      // uncertain operation rather than falsely claiming no side effect.
      if (signal.aborted) {
        throw new Error(
          "The request was cancelled before the server confirmed it. Poll operation status before retrying."
        )
      }

      const fetchImpl = deps.fetchFn ?? globalThis.fetch
      const response = await fetchImpl("/api/scans", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.requestId,
        },
        body: JSON.stringify({
          workspaceId: deps.workspaceId,
          targetId: target.id,
          goal: selectedOption.goal,
          mode: selectedOption.mode,
        }),
        signal,
      })
      const body = (await response.json().catch(() => null)) as {
        data?: { id?: string; operationId?: string }
        error?: { code?: string; message?: string }
      } | null
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "The scan could not be started.")
      }
      return {
        started: true,
        scanId: body?.data?.id,
        operationId: body?.data?.operationId,
        target: { name: target.name, type: target.type },
        reviewType: { id: selectedOption.id, label: selectedOption.label },
        note: "The scan is durable. Poll its status or open it in Scans.",
      }
    },
  }
}
