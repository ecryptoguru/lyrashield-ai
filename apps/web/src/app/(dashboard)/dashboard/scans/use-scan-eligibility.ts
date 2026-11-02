import { useEffect, useState } from "react"
import { ApiError, apiGet } from "@/lib/api-client"
import { scanEligibilitySchema } from "@/lib/api-schemas"
import type { ManualScanOption } from "@/lib/scan-presets"
import type { ScanEligibilityState } from "./scan-types"
import type { parseEngineBudgetField } from "./scan-advanced-options"

export function useScanEligibility({
  showCreate,
  workspaceId,
  selectedTarget,
  selectedOption,
  engineBudget,
}: {
  showCreate: boolean
  workspaceId: string
  selectedTarget: string
  selectedOption?: ManualScanOption
  engineBudget: ReturnType<typeof parseEngineBudgetField>
}) {
  const [eligibility, setEligibility] = useState<ScanEligibilityState>({ status: "idle" })
  const [eligibilityAttempt, setEligibilityAttempt] = useState(0)
  // ─── Eligibility preflight (advisory; POST re-checks authoritatively) ────
  useEffect(() => {
    if (!showCreate || !selectedTarget || !selectedOption || engineBudget.error) {
      // Deferred so the reset lands inside a callback, not the synchronous
      // effect body (avoids cascading renders).
      let cancelled = false
      const reset = () => {
        if (!cancelled) setEligibility({ status: "idle" })
      }
      if (typeof queueMicrotask === "function") queueMicrotask(reset)
      else setTimeout(reset, 0)
      return () => {
        cancelled = true
      }
    }
    const controller = new AbortController()
    // Deferred so the pending state lands inside a callback, not the
    // synchronous effect body (avoids cascading renders).
    let cancelled = false
    const schedule = () => {
      if (cancelled) return
      setEligibility({ status: "checking" })
      apiGet(
        `/api/scans/eligibility?${new URLSearchParams({
          workspaceId,
          targetId: selectedTarget,
          goal: selectedOption.goal,
          mode: selectedOption.mode,
          ...(engineBudget.value !== undefined
            ? { engineBudgetCeilingUsd: String(engineBudget.value) }
            : {}),
        }).toString()}`,
        { schema: scanEligibilitySchema, signal: controller.signal }
      )
        .then((result) => {
          if (!controller.signal.aborted && result) {
            setEligibility({ status: "ready", eligibility: result })
          }
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          if (err instanceof ApiError) {
            // Structured 4xx (e.g. invalid target) still carries a user-safe reason.
            setEligibility({
              status: "ready",
              eligibility: {
                allowed: false,
                code: err.code ?? "ELIGIBILITY_UNAVAILABLE",
                message: err.message,
                plan: "UNKNOWN",
                isTrial: false,
                remainingMinutes: 0,
              },
            })
          } else {
            setEligibility({ status: "error" })
          }
        })
    }
    if (typeof queueMicrotask === "function") queueMicrotask(schedule)
    else setTimeout(schedule, 0)
    return () => {
      cancelled = true
      controller.abort()
    }
    // selectedOption is derived from a freshly-built options array each render,
    // so the effect keys on its identity fields instead of the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showCreate,
    workspaceId,
    selectedTarget,
    engineBudget.error,
    engineBudget.value,
    selectedOption?.goal,
    selectedOption?.mode,
    eligibilityAttempt,
  ])
  return { eligibility, setEligibilityAttempt }
}
